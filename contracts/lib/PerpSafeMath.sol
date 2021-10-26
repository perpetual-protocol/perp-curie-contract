// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;
pragma abicoder v2;

import { PerpSafeCast } from "./PerpSafeCast.sol";
import { SafeMathUpgradeable } from "@openzeppelin/contracts-upgradeable/math/SafeMathUpgradeable.sol";
import { SignedSafeMathUpgradeable } from "@openzeppelin/contracts-upgradeable/math/SignedSafeMathUpgradeable.sol";

library PerpSafeMath {
    using SignedSafeMathUpgradeable for int24;
    using SignedSafeMathUpgradeable for int128;
    using SafeMathUpgradeable for uint24;
    using SafeMathUpgradeable for uint128;
    using PerpSafeCast for uint256;
    using PerpSafeCast for int256;

    /**
     * safeMath for 24 bit
     */

    function sub24(uint24 a, uint24 b) internal pure returns (uint24) {
        return (a.sub(b)).toUint24();
    }

    function sub24(int24 a, int24 b) internal pure returns (int24) {
        return (a.sub(b)).toInt24();
    }

    function add24(uint24 a, uint24 b) internal pure returns (uint24) {
        return (a.add(b)).toUint24();
    }

    function add24(int24 a, int24 b) internal pure returns (int24) {
        return (a.add(b)).toInt24();
    }

    /**
     * safeMath for 128 bit
     */

    function sub128(uint128 a, uint128 b) internal pure returns (uint128) {
        return (a.sub(b)).toUint128();
    }

    function sub128(int128 a, int128 b) internal pure returns (int128) {
        return (a.sub(b)).toInt128();
    }

    function add128(uint128 a, uint128 b) internal pure returns (uint128) {
        return (a.add(b)).toUint128();
    }

    function add128(int128 a, int128 b) internal pure returns (int128) {
        return (a.add(b)).toInt128();
    }
}
