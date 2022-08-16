// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.7.6;

import { SafeMathUpgradeable } from "@openzeppelin/contracts-upgradeable/math/SafeMathUpgradeable.sol";
import { SignedSafeMathUpgradeable } from "@openzeppelin/contracts-upgradeable/math/SignedSafeMathUpgradeable.sol";

/// @dev decimals of settlementToken token MUST be less than 18
library SettlementTokenMath {
    using SafeMathUpgradeable for uint256;
    using SignedSafeMathUpgradeable for int256;

    function lte(
        uint256 settlementToken,
        // solhint-disable-next-line var-name-mixedcase
        uint256 amountX10_18,
        uint8 decimals
    ) internal pure returns (bool) {
        return parseSettlementToken(settlementToken, decimals) <= amountX10_18;
    }

    function lte(
        int256 settlementToken,
        // solhint-disable-next-line var-name-mixedcase
        int256 amountX10_18,
        uint8 decimals
    ) internal pure returns (bool) {
        return parseSettlementToken(settlementToken, decimals) <= amountX10_18;
    }

    function lt(
        uint256 settlementToken,
        // solhint-disable-next-line var-name-mixedcase
        uint256 amountX10_18,
        uint8 decimals
    ) internal pure returns (bool) {
        return parseSettlementToken(settlementToken, decimals) < amountX10_18;
    }

    function lt(
        int256 settlementToken,
        // solhint-disable-next-line var-name-mixedcase
        int256 amountX10_18,
        uint8 decimals
    ) internal pure returns (bool) {
        return parseSettlementToken(settlementToken, decimals) < amountX10_18;
    }

    function gt(
        uint256 settlementToken,
        // solhint-disable-next-line var-name-mixedcase
        uint256 amountX10_18,
        uint8 decimals
    ) internal pure returns (bool) {
        return parseSettlementToken(settlementToken, decimals) > amountX10_18;
    }

    function gt(
        int256 settlementToken,
        // solhint-disable-next-line var-name-mixedcase
        int256 amountX10_18,
        uint8 decimals
    ) internal pure returns (bool) {
        return parseSettlementToken(settlementToken, decimals) > amountX10_18;
    }

    function gte(
        uint256 settlementToken,
        // solhint-disable-next-line var-name-mixedcase
        uint256 amountX10_18,
        uint8 decimals
    ) internal pure returns (bool) {
        return parseSettlementToken(settlementToken, decimals) >= amountX10_18;
    }

    function gte(
        int256 settlementToken,
        // solhint-disable-next-line var-name-mixedcase
        int256 amountX10_18,
        uint8 decimals
    ) internal pure returns (bool) {
        return parseSettlementToken(settlementToken, decimals) >= amountX10_18;
    }

    // returns number with 18 decimals
    function parseSettlementToken(uint256 amount, uint8 decimals) internal pure returns (uint256) {
        return amount.mul(10**(18 - decimals));
    }

    // returns number with 18 decimals
    function parseSettlementToken(int256 amount, uint8 decimals) internal pure returns (int256) {
        return amount.mul(int256(10**(18 - decimals)));
    }

    // returns number converted from 18 decimals to settlementToken's decimals
    function formatSettlementToken(uint256 amount, uint8 decimals) internal pure returns (uint256) {
        return amount.div(10**(18 - decimals));
    }

    // returns number converted from 18 decimals to settlementToken's decimals
    // will always round down no matter positive value or negative value
    function formatSettlementToken(int256 amount, uint8 decimals) internal pure returns (int256) {
        uint256 denominator = 10**(18 - decimals);
        int256 rounding = 0;
        if (amount < 0 && uint256(-amount) % denominator != 0) {
            rounding = -1;
        }
        return amount.div(int256(denominator)).add(rounding);
    }

    // returns number converted between specified decimals
    function convertTokenDecimals(
        uint256 amount,
        uint8 fromDecimals,
        uint8 toDecimals
    ) internal pure returns (uint256) {
        if (fromDecimals == toDecimals) {
            return amount;
        }
        return
            fromDecimals > toDecimals
                ? amount.div(10**(fromDecimals - toDecimals))
                : amount.mul(10**(toDecimals - fromDecimals));
    }

    // returns number converted between specified decimals
    function convertTokenDecimals(
        int256 amount,
        uint8 fromDecimals,
        uint8 toDecimals
    ) internal pure returns (int256) {
        if (fromDecimals == toDecimals) {
            return amount;
        }

        if (fromDecimals < toDecimals) {
            return amount.mul(int256(10**(toDecimals - fromDecimals)));
        }

        uint256 denominator = 10**(fromDecimals - toDecimals);
        int256 rounding = 0;
        if (amount < 0 && uint256(-amount) % denominator != 0) {
            rounding = -1;
        }
        return amount.div(int256(denominator)).add(rounding);
    }
}
