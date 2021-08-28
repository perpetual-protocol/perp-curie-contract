// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;
pragma abicoder v2;

import { FullMath } from "@uniswap/v3-core/contracts/libraries/FullMath.sol";
import { SafeMath } from "@openzeppelin/contracts/math/SafeMath.sol";
import { UniswapV3Broker } from "./UniswapV3Broker.sol";

library FeeMath {
    using SafeMath for uint256;

    function calcAmountScaledByFeeRatio(
        uint256 amount,
        uint24 feeRatio,
        bool isScaledUp
    ) internal pure returns (uint256) {
        // when scaling up, round up to avoid imprecision; it's okay as long as we round down later
        return
            isScaledUp
                ? FullMath.mulDivRoundingUp(amount, 1e6, uint256(1e6).sub(feeRatio))
                : FullMath.mulDiv(amount, uint256(1e6).sub(feeRatio), 1e6);
    }

    /// @param isReplacingUniswapFeeRatio is to replace uniswapFeeRatio or clearingHouseFeeRatio
    ///        let x : uniswapFeeRatio, y : clearingHouseFeeRatio
    ///        true: replacing uniswapFeeRatio with clearingHouseFeeRatio: amount * (1 - y) / (1 - x)
    ///        false: replacing clearingHouseFeeRatio with uniswapFeeRatio: amount * (1 - x) / (1 - y)
    ///        multiplying a fee is applying it as the new standard and dividing a fee is removing its effect
    /// @dev calculate the amount when feeRatio is switched between uniswapFeeRatio and clearingHouseFeeRatio
    function calcAmountWithFeeRatioReplaced(
        uint256 amount,
        uint24 uniswapFeeRatio,
        uint24 clearingHouseFeeRatio,
        bool isReplacingUniswapFeeRatio
    ) internal pure returns (uint256) {
        (uint24 newFee, uint24 replacedFee) =
            isReplacingUniswapFeeRatio
                ? (clearingHouseFeeRatio, uniswapFeeRatio)
                : (uniswapFeeRatio, clearingHouseFeeRatio);

        return FullMath.mulDivRoundingUp(amount, uint256(1e6).sub(newFee), uint256(1e6).sub(replacedFee));
    }

    /// @param amount depending on isBaseToQuote & isExactInput, either input or output amount needs to be scaled
    /// @return scaledAmount the scaled amount for UniswapV3Pool.swap()
    function calcScaledAmountForUniswapV3PoolSwap(
        bool isBaseToQuote,
        bool isExactInput,
        uint256 amount,
        uint24 clearingHouseFeeRatio,
        uint24 uniswapFeeRatio
    ) internal pure returns (uint256 scaledAmount) {
        // let x : uniswapFeeRatio, y : clearingHouseFeeRatio
        // 1. isBaseToQuote && isExactInput   --> input base / (1 - x)
        // 2. isBaseToQuote && !isExactInput  --> output base / (1 - y)
        // 3. !isBaseToQuote && isExactInput  --> input quote * (1 - y) / (1 - x)
        // 4. !isBaseToQuote && !isExactInput --> output base
        if (isBaseToQuote) {
            scaledAmount = isExactInput
                ? calcAmountScaledByFeeRatio(amount, uniswapFeeRatio, true)
                : calcAmountScaledByFeeRatio(amount, clearingHouseFeeRatio, true);
        } else {
            scaledAmount = isExactInput
                ? calcAmountWithFeeRatioReplaced(amount, uniswapFeeRatio, clearingHouseFeeRatio, true)
                : amount;
        }
    }
}
