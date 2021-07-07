pragma solidity 0.7.6;
pragma abicoder v2;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Math } from "@openzeppelin/contracts/math/Math.sol";
import { SafeMath } from "@openzeppelin/contracts/math/SafeMath.sol";
import { SignedSafeMath } from "@openzeppelin/contracts/math/SignedSafeMath.sol";
import { Context } from "@openzeppelin/contracts/utils/Context.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { SafeCast } from "@openzeppelin/contracts/utils/SafeCast.sol";
import { IUniswapV3Pool } from "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import { IUniswapV3SwapCallback } from "@uniswap/v3-core/contracts/interfaces/callback/IUniswapV3SwapCallback.sol";
import { FullMath } from "@uniswap/v3-core/contracts/libraries/FullMath.sol";
import { FixedPoint128 } from "@uniswap/v3-core/contracts/libraries/FixedPoint128.sol";
import { FixedPoint96 } from "@uniswap/v3-core/contracts/libraries/FixedPoint96.sol";
import { UniswapV3Broker } from "./lib/UniswapV3Broker.sol";
import { ClearingHouse } from "./ClearingHouse.sol";
import { TickMath } from "@uniswap/v3-core/contracts/libraries/TickMath.sol";

contract ClearingHouseQuoter is IUniswapV3SwapCallback, ReentrancyGuard, Context, Ownable {
    using SafeMath for uint256;
    using SafeCast for uint256;
    using SafeCast for uint128;
    using SignedSafeMath for int256;
    using SafeCast for int256;

    //
    // events
    //

    //
    // Struct
    //
    struct SwapParams {
        address baseToken;
        address quoteToken;
        bool isBaseToQuote;
        bool isExactInput;
        uint256 amount;
        uint160 sqrtPriceLimitX96; // price slippage protection
    }

    //
    // state variables
    //
    address public immutable clearingHouse;

    constructor(address clearingHouseArg) {
        // CQ_II: invalid input ClearingHouse
        require(clearingHouseArg != address(0), "CQ_II_CH");
        clearingHouse = clearingHouseArg;
    }

    //
    // EXTERNAL FUNCTIONS
    //
    function uniswapV3SwapCallback(
        int256,
        int256 amount1Delta,
        bytes memory data
    ) external view override {
        // swaps entirely within 0-liquidity regions are not supported -> 0 swap is forbidden
        // CQ_F0S: forbidden 0 swap
        require(amount1Delta > 0, "CQ_F0S");

        address baseToken = abi.decode(data, (address));
        address pool = ClearingHouse(clearingHouse).getPool(baseToken);
        // CQ_FSV: failed swapCallback verification
        require(_msgSender() == pool, "CQ_FSV");

        uint256 positionValue = amount1Delta > 0 ? amount1Delta.toUint256() : -amount1Delta.toUint256();
        assembly {
            let ptr := mload(0x40)
            mstore(ptr, positionValue)
            revert(ptr, 32)
        }
    }

    //
    // EXTERNAL VIEW FUNCTIONS
    //

    //
    // INTERNAL FUNCTIONS
    //
    // cannot be view function because of try/catch
    function getPositionValue(
        address pool,
        address token,
        uint256 baseAvailable,
        uint256 baseDebt
    ) public returns (uint256 positionValue) {
        // CQ_IMS: invalid msg.sender
        require(_msgSender() == clearingHouse, "CQ_IMS");

        bool isBaseToQuote;
        int256 specifiedAmount;
        if (baseAvailable >= baseDebt) {
            // exact base to quote -> isExactInput -> specifiedAmount > 0
            isBaseToQuote = true;
            specifiedAmount = baseAvailable.sub(baseDebt).toInt256();
        } else {
            // quote to exact base -> !isExactInput -> specifiedAmount < 0
            specifiedAmount = -(baseDebt.sub(baseAvailable)).toInt256();
        }

        try
            IUniswapV3Pool(pool).swap(
                address(this),
                isBaseToQuote,
                specifiedAmount,
                (isBaseToQuote ? TickMath.MIN_SQRT_RATIO + 1 : TickMath.MAX_SQRT_RATIO - 1),
                abi.encode(token)
            )
        {} catch (bytes memory reason) {
            return _getParsedRevertReason(reason);
        }
    }

    //
    // INTERNAL VIEW FUNCTIONS
    //
    function _getParsedRevertReason(bytes memory reason) private pure returns (uint256) {
        if (reason.length != 32) {
            if (reason.length < 68) revert("Unexpected error");
            assembly {
                reason := add(reason, 0x04)
            }
            revert(abi.decode(reason, (string)));
        }
        return abi.decode(reason, (uint256));
    }
}
