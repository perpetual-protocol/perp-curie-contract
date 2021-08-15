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
        address pool,
        uint256 amount,
        bool isScaledUp
    ) internal view returns (uint256) {
        // when scaling up, round up to avoid imprecision; it's okay as long as we round down later
        return
            isScaledUp
                ? FullMath.mulDivRoundingUp(amount, 1e6, uint256(1e6).sub(UniswapV3Broker.getUniswapFeeRatio(pool)))
                : FullMath.mulDiv(amount, uint256(1e6).sub(UniswapV3Broker.getUniswapFeeRatio(pool)), 1e6);
    }
}
