// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;

library OrderKey {
    function compute(
        address trader,
        address baseToken,
        int24 lowerTick,
        int24 upperTick
    ) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(trader, baseToken, lowerTick, upperTick));
    }
}
