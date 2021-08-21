// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;
pragma abicoder v2;

import { FixedPoint96 } from "@uniswap/v3-core/contracts/libraries/FixedPoint96.sol";
import { FullMath } from "@uniswap/v3-core/contracts/libraries/FullMath.sol";
import { PerpSafeCast } from "./PerpSafeCast.sol";
import { SafeMath } from "@openzeppelin/contracts/math/SafeMath.sol";
import { SignedSafeMath } from "@openzeppelin/contracts/math/SignedSafeMath.sol";

library PerpMath {
    using PerpSafeCast for int256;
    using SignedSafeMath for int256;
    using SafeMath for uint256;

    // Note: overflow inspection:
    // say sqrtPriceX96 = 10000; the max value in this calculation process is: (10000 * (2 ^ 96)) ^ 2
    // -> the max number of digits required is log((10000 * (2 ^ 96)) ^ 2)/log(2) = 218.57 < 256
    function formatSqrtPriceX96ToPriceX10_18(uint160 sqrtPriceX96) internal pure returns (uint256) {
        // sqrtPriceX96 = sqrtPrice * (2 ^ 96)
        // priceX96 = sqrtPriceX96 ^ 2 / (2 ^ 96) = ((sqrtPrice * (2 ^ 96)) ^ 2) / (2 ^ 96)
        //          = (sqrtPrice ^ 2) * (2 ^ 96) = price * (2 ^ 96)
        uint256 priceX96 = FullMath.mulDiv(sqrtPriceX96, sqrtPriceX96, FixedPoint96.Q96);

        // priceX10_18 = priceX96 * (10 ^ 18) / (2 ^ 96) = price * (2 ^ 96) * (10 ^ 18) / (2 ^ 96) = price * (10 ^ 18)
        return FullMath.mulDiv(priceX96, 1 ether, FixedPoint96.Q96);
    }

    function formatSqrtPriceX96ToPriceX96(uint160 sqrtPriceX96) internal pure returns (uint256) {
        return FullMath.mulDiv(sqrtPriceX96, sqrtPriceX96, FixedPoint96.Q96);
    }

    function formatX10_18ToX96(uint256 valueX10_18) internal pure returns (uint256) {
        return FullMath.mulDiv(valueX10_18, FixedPoint96.Q96, 1 ether);
    }

    function abs(int256 value) internal pure returns (uint256) {
        return value > 0 ? value.toUint256() : (-value).toUint256();
    }

    function divideBy10_18(int256 value) internal pure returns (int256) {
        return value.div(1 ether);
    }

    function divideBy10_18(uint256 value) internal pure returns (uint256) {
        return value.div(1 ether);
    }
}
