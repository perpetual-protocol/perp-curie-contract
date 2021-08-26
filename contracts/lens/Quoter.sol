// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;
pragma abicoder v2;

import { IUniswapV3Pool } from "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import { TickMath } from "@uniswap/v3-core/contracts/libraries/TickMath.sol";
import { IUniswapV3SwapCallback } from "@uniswap/v3-core/contracts/interfaces/callback/IUniswapV3SwapCallback.sol";
import { FullMath } from "@uniswap/v3-core/contracts/libraries/FullMath.sol";
import { SafeMath } from "@openzeppelin/contracts/math/SafeMath.sol";
import { SignedSafeMath } from "@openzeppelin/contracts/math/SignedSafeMath.sol";
import { PerpSafeCast } from "../lib/PerpSafeCast.sol";
import { PerpMath } from "../lib/PerpMath.sol";
import { FeeMath } from "../lib/FeeMath.sol";
import { Exchange } from "../Exchange.sol";

/// @title Provides quotes for swaps
/// @notice Allows getting the expected amount out or amount in for a given swap without executing the swap
/// @dev These functions are not gas efficient and should _not_ be called on chain. Instead, optimistically execute
/// the swap and check the amounts in the callback.
contract Quoter is IUniswapV3SwapCallback {
    using SafeMath for uint256;
    using PerpSafeCast for uint256;
    using SignedSafeMath for int256;
    using PerpMath for int256;

    address public exchange;

    struct SwapParams {
        address baseToken;
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

    constructor(address exchangeArg) {
        // Q_EX0: exchange is 0
        require(exchangeArg != address(0), "Q_EX0");
        exchange = exchangeArg;
    }

    function swap(SwapParams memory params) external returns (SwapResponse memory response) {
        // Q_ZI: zero input
        require(params.amount > 0, "Q_ZI");

        address pool = Exchange(exchange).getPool(params.baseToken);
        // Q_BTNE: base token not exists
        require(pool != address(0), "Q_BTNE");

        // TODO: maybe can merge this two fee ratios into one
        uint24 uniswapFeeRatio = Exchange(exchange).getUniswapFeeRatio(params.baseToken);
        uint24 exchangeFeeRatio = Exchange(exchange).getFeeRatio(params.baseToken);

        // scale up before swap to cover uniswap fee
        uint256 scaledAmount =
            params.isBaseToQuote
                ? params.isExactInput
                    ? FeeMath.calcAmountScaledByFeeRatio(params.amount, uniswapFeeRatio, true)
                    : FeeMath.calcAmountScaledByFeeRatio(params.amount, exchangeFeeRatio, true)
                : params.isExactInput
                ? FeeMath.calcAmountWithFeeRatioReplaced(params.amount, uniswapFeeRatio, exchangeFeeRatio, true)
                : params.amount;
        // UniswapV3Pool will use a signed value to determine isExactInput or not.
        int256 specifiedAmount = params.isExactInput ? scaledAmount.toInt256() : -scaledAmount.toInt256();

        try
            IUniswapV3Pool(pool).swap(
                address(this),
                params.isBaseToQuote,
                specifiedAmount,
                params.sqrtPriceLimitX96 == 0
                    ? (params.isBaseToQuote ? TickMath.MIN_SQRT_RATIO + 1 : TickMath.MAX_SQRT_RATIO - 1)
                    : params.sqrtPriceLimitX96,
                abi.encode(params.baseToken)
            )
        // solhint-disable-next-line no-empty-blocks
        {

        } catch (bytes memory reason) {
            (uint256 base, uint256 quote) = _parseRevertReason(reason);

            uint256 fee = FullMath.mulDivRoundingUp(quote, exchangeFeeRatio, 1e6);
            int256 exchangedPositionSize;
            int256 exchangedPositionNotional;

            if (params.isBaseToQuote) {
                fee = FullMath.mulDivRoundingUp(quote, exchangeFeeRatio, 1e6);
                // short: exchangedPositionSize <= 0 && exchangedPositionNotional >= 0
                exchangedPositionSize = -(FeeMath.calcAmountScaledByFeeRatio(base, uniswapFeeRatio, false).toInt256());
                // due to base to quote fee, exchangedPositionNotional contains the fee
                // s.t. we can take the fee away from exchangedPositionNotional
                exchangedPositionNotional = quote.toInt256();
            } else {
                // check the doc of custom fee for more details,
                // qr * ((1 - x) / (1 - y)) * y ==> qr * y * (1-x) / (1-y)
                fee = FeeMath
                    .calcAmountWithFeeRatioReplaced(quote * exchangeFeeRatio, uniswapFeeRatio, exchangeFeeRatio, false)
                    .div(1e6);

                // long: exchangedPositionSize >= 0 && exchangedPositionNotional <= 0
                exchangedPositionSize = base.toInt256();
                exchangedPositionNotional = -(
                    FeeMath.calcAmountScaledByFeeRatio(quote, uniswapFeeRatio, false).toInt256()
                );
            }
            response = SwapResponse(
                exchangedPositionSize.abs(), // deltaAvailableBase
                exchangedPositionNotional.sub(fee.toInt256()).abs(), // deltaAvailableQuote
                exchangedPositionSize.abs(),
                exchangedPositionNotional.abs()
            );

            // if it's exact output with a price limit, ensure that the full output amount has been receive
            if (!params.isExactInput && params.sqrtPriceLimitX96 == 0) {
                uint256 amountReceived =
                    params.isBaseToQuote ? response.deltaAvailableQuote : response.deltaAvailableBase;
                // Q_UOA: unmatched output amount
                require(amountReceived == params.amount, "Q_UOA");
            }
        }
    }

    /// @inheritdoc IUniswapV3SwapCallback
    function uniswapV3SwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes memory data
    ) external view override {
        // swaps entirely within 0-liquidity regions are not supported -> 0 swap is forbidden
        // Q_F0S: forbidden 0 swap
        require(amount0Delta > 0 || amount1Delta > 0, "Q_F0S");

        address baseToken = abi.decode(data, (address));
        address pool = Exchange(exchange).getPool(baseToken);
        // CH_FSV: failed swapCallback verification
        require(msg.sender == pool, "Q_FSV");

        (uint256 base, uint256 quote) = (amount0Delta.abs(), amount1Delta.abs());

        // solhint-disable-next-line no-inline-assembly
        assembly {
            let ptr := mload(0x40)
            mstore(ptr, base)
            mstore(add(ptr, 0x20), quote)
            revert(ptr, 64)
        }
    }

    /// @dev Parses a revert reason that should contain the numeric quote
    function _parseRevertReason(bytes memory reason) private pure returns (uint256 base, uint256 quote) {
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
