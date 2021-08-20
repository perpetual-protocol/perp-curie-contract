// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;
pragma abicoder v2;

import { FullMath } from "@uniswap/v3-core/contracts/libraries/FullMath.sol";
import { SafeMath } from "@openzeppelin/contracts/math/SafeMath.sol";
import { UniswapV3Broker } from "./UniswapV3Broker.sol";

library FeeMath {
    using SafeMath for uint256;

    // the calculation has to be modified for exactInput or exactOutput if we have our own feeRatio
    function calcScaledAmount(
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

    // FIXME: have a better name
    // calculate amount * (1-uniswapFeeRatio) / (1-clearingHouseFeeRatio)
    function magicFactor(
        uint256 amount,
        uint24 uniswapFeeRatio,
        uint24 clearingHouseFeeRatio,
        bool isScaledUp
    ) internal pure returns (uint256) {
        return
            isScaledUp
                ? FullMath.mulDivRoundingUp(amount, uint256(1e6 - uniswapFeeRatio), 1e6 - clearingHouseFeeRatio)
                : FullMath.mulDivRoundingUp(amount, uint256(1e6 - clearingHouseFeeRatio), 1e6 - uniswapFeeRatio);
    }
}
