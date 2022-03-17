// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.7.6;
pragma abicoder v2;

import { PerpSafeCast } from "../lib/PerpSafeCast.sol";

contract TestPerpSafeCast {
    using PerpSafeCast for uint256;
    using PerpSafeCast for int256;

    // uint test

    // int256 to uin256
    function testToUint256(int256 value) external pure returns (uint256) {
        return value.toUint256();
    }

    function testToUint128(uint256 value) external pure returns (uint128) {
        return value.toUint128();
    }

    function testToUint64(uint256 value) external pure returns (uint64) {
        return value.toUint64();
    }

    function testToUint32(uint256 value) external pure returns (uint32) {
        return value.toUint32();
    }

    // int24 to uint24
    function testToUint24(int256 value) external pure returns (uint24) {
        return value.toUint24();
    }

    function testToUint16(uint256 value) external pure returns (uint16) {
        return value.toUint16();
    }

    function testToUint8(uint256 value) external pure returns (uint8) {
        return value.toUint8();
    }

    // int test

    // uint256 to int256
    function testToInt256(uint256 value) external pure returns (int256) {
        return value.toInt256();
    }

    function testToInt128(int256 value) external pure returns (int128) {
        return value.toInt128();
    }

    function testToInt64(int256 value) external pure returns (int64) {
        return value.toInt64();
    }

    function testToInt32(int256 value) external pure returns (int32) {
        return value.toInt32();
    }

    function testToInt24(int256 value) external pure returns (int24) {
        return value.toInt24();
    }

    function testToInt16(int256 value) external pure returns (int16) {
        return value.toInt16();
    }

    function testToInt8(int256 value) external pure returns (int8) {
        return value.toInt8();
    }
}
