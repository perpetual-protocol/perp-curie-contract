// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;
pragma abicoder v2;

import { IUniswapV3Pool } from "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import { TickMath } from "@uniswap/v3-core/contracts/libraries/TickMath.sol";
import { IUniswapV3SwapCallback } from "@uniswap/v3-core/contracts/interfaces/callback/IUniswapV3SwapCallback.sol";
import { FullMath } from "@uniswap/v3-core/contracts/libraries/FullMath.sol";
import { SafeMath } from "@openzeppelin/contracts/math/SafeMath.sol";
import { SignedSafeMath } from "@openzeppelin/contracts/math/SignedSafeMath.sol";
import { SafeCast } from "@openzeppelin/contracts/utils/SafeCast.sol";
import { PerpMath } from "../lib/PerpMath.sol";
import { FeeMath } from "../lib/FeeMath.sol";

/// @title Provides quotes for swaps
/// @notice Allows getting the expected amount out or amount in for a given swap without executing the swap
/// @dev These functions are not gas efficient and should _not_ be called on chain. Instead, optimistically execute
/// the swap and check the amounts in the callback.
contract Quoter is IUniswapV3SwapCallback {
    using SafeMath for uint256;
    using SafeCast for uint256;
    using SignedSafeMath for int256;
    using PerpMath for int256;

    /// @dev Transient storage variable used to check a safety condition in exact output swaps.
    uint256 private _amountOutCached;

    struct SwapParams {
        address pool;
        bool isBaseToQuote;
        bool isExactInput;
        uint256 amount;
        uint160 sqrtPriceLimitX96; // price slippage protection
    }

    struct SwapResponse {
        uint256 deltaAvailableBase;
        uint256 deltaAvailableQuote;
        uint256 exchangedPositionSize;
        uint256 exchangedPositionNotional;
    }

    function swap(SwapParams memory params) public returns (SwapResponse memory response) {
        // zero input
        require(params.amount > 0, "Q_ZI");

        // if no price limit has been specified, cache the output amount for comparison in the swap callback
        if (!params.isExactInput && params.sqrtPriceLimitX96 == 0) {
            _amountOutCached = params.amount;
        }

        uint256 amount = params.amount;
        if (params.isBaseToQuote) {
            // scale base token before swap
            amount = FeeMath.calcScaledAmount(params.pool, params.amount, true);
        }

        // UniswapV3Pool will use a signed value to determine isExactInput or not.
        int256 specifiedAmount = params.isExactInput ? amount.toInt256() : -amount.toInt256();

        try
            IUniswapV3Pool(params.pool).swap(
                address(this),
                params.isBaseToQuote,
                specifiedAmount,
                params.sqrtPriceLimitX96 == 0
                    ? (params.isBaseToQuote ? TickMath.MIN_SQRT_RATIO + 1 : TickMath.MAX_SQRT_RATIO - 1)
                    : params.sqrtPriceLimitX96,
                abi.encode(params.isBaseToQuote, params.isExactInput)
            )
        // solhint-disable-next-line no-empty-blocks
        {

        } catch (bytes memory reason) {
            (uint256 amountBase, uint256 amountQuote) = _parseRevertReason(reason);

            uint24 uniswapFeeRatio = IUniswapV3Pool(params.pool).fee();
            uint256 fee = FullMath.mulDivRoundingUp(amountQuote, uniswapFeeRatio, 1e6);
            int256 exchangedPositionSize;
            int256 exchangedPositionNotional;

            if (params.isBaseToQuote) {
                // short: exchangedPositionSize <= 0 && exchangedPositionNotional >= 0
                exchangedPositionSize = -(FeeMath.calcScaledAmount(params.pool, amountBase, false).toInt256());
                // due to base to quote fee, exchangedPositionNotional contains the fee
                // s.t. we can take the fee away from exchangedPositionNotional(exchangedPositionNotional)
                exchangedPositionNotional = amountQuote.toInt256();
            } else {
                // long: exchangedPositionSize >= 0 && exchangedPositionNotional <= 0
                exchangedPositionSize = amountBase.toInt256();
                // as fee is charged by Uniswap pool already, exchangedPositionNotional does not include fee
                exchangedPositionNotional = -(amountQuote.sub(fee).toInt256());
            }
            response = SwapResponse(
                exchangedPositionSize.abs(), // deltaAvailableBase
                exchangedPositionNotional.sub(fee.toInt256()).abs(), // deltaAvailableQuote
                exchangedPositionSize.abs(),
                exchangedPositionNotional.abs()
            );

            // if the cache has been populated, ensure that the full output amount has been receive
            if (!params.isExactInput && _amountOutCached != 0) {
                uint256 amountReceived =
                    params.isBaseToQuote ? response.deltaAvailableQuote : response.deltaAvailableBase;
                require(amountReceived == _amountOutCached, "Q_UOA");
                delete _amountOutCached;
            }
        }
    }

    /// @inheritdoc IUniswapV3SwapCallback
    function uniswapV3SwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes memory
    ) external pure override {
        // swaps entirely within 0-liquidity regions are not supported
        require(amount0Delta > 0 || amount1Delta > 0, "Q_ZL");

        (uint256 amountBase, uint256 amountQuote) = (amount0Delta.abs(), amount1Delta.abs());

        // solhint-disable-next-line no-inline-assembly
        assembly {
            let ptr := mload(0x40)
            mstore(ptr, amountBase)
            mstore(add(ptr, 0x20), amountQuote)
            revert(ptr, 64)
        }
    }

    /// @dev Parses a revert reason that should contain the numeric quote
    function _parseRevertReason(bytes memory reason) private pure returns (uint256 amountBase, uint256 amountQuote) {
        if (reason.length != 64) {
            if (reason.length < 68) revert("Unexpected error");
            // solhint-disable-next-line no-inline-assembly
            assembly {
                reason := add(reason, 0x04)
            }
            revert(abi.decode(reason, (string)));
        }
        return abi.decode(reason, (uint256, uint256));
    }
}
