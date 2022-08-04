// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.7.6;

import { PerpMath } from "../lib/PerpMath.sol";

contract TestPerpMath {
    using PerpMath for uint160;
    using PerpMath for uint256;
    using PerpMath for int256;

    function testFormatSqrtPriceX96ToPriceX96(uint160 value) external pure returns (uint256) {
        return value.formatSqrtPriceX96ToPriceX96();
    }

    function testFormatX10_18ToX96(uint256 value) external pure returns (uint256) {
        return value.formatX10_18ToX96();
    }

    function testFormatX96ToX10_18(uint256 value) external pure returns (uint256) {
        return value.formatX96ToX10_18();
    }

    function testMax(int256 a, int256 b) external pure returns (int256) {
        return PerpMath.max(a, b);
    }

    function testMin(int256 a, int256 b) external pure returns (int256) {
        return PerpMath.min(a, b);
    }

    function testAbs(int256 value) external pure returns (uint256) {
        return value.abs();
    }

    function testDivBy10_18(int256 value) external pure returns (int256) {
        return value.divBy10_18();
    }

    function testDivBy10_18(uint256 value) external pure returns (uint256) {
        return value.divBy10_18();
    }

    function testMulRatio(uint256 value, uint24 ratio) external pure returns (uint256) {
        return value.mulRatio(ratio);
    }

    function testMulRatio(int256 value, uint24 ratio) external pure returns (int256) {
        return value.mulRatio(ratio);
    }
}
