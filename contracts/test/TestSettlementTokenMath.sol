// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;

import { SettlementTokenMath } from "../lib/SettlementTokenMath.sol";

contract TestSettlementTokenMath {
    using SettlementTokenMath for uint256;
    using SettlementTokenMath for int256;

    function testLte(
        uint256 settlementToken,
        // solhint-disable-next-line var-name-mixedcase
        uint256 amountX10_18,
        uint8 decimals
    ) external pure returns (bool) {
        return settlementToken.lte(amountX10_18, decimals);
    }

    function testLte(
        int256 settlementToken,
        // solhint-disable-next-line var-name-mixedcase
        int256 amountX10_18,
        uint8 decimals
    ) external pure returns (bool) {
        return settlementToken.lte(amountX10_18, decimals);
    }

    function testLt(
        uint256 settlementToken,
        // solhint-disable-next-line var-name-mixedcase
        uint256 amountX10_18,
        uint8 decimals
    ) external pure returns (bool) {
        return settlementToken.lt(amountX10_18, decimals);
    }

    function testLt(
        int256 settlementToken,
        // solhint-disable-next-line var-name-mixedcase
        int256 amountX10_18,
        uint8 decimals
    ) external pure returns (bool) {
        return settlementToken.lt(amountX10_18, decimals);
    }

    function testGte(
        uint256 settlementToken,
        // solhint-disable-next-line var-name-mixedcase
        uint256 amountX10_18,
        uint8 decimals
    ) external pure returns (bool) {
        return settlementToken.gte(amountX10_18, decimals);
    }

    function testGte(
        int256 settlementToken,
        // solhint-disable-next-line var-name-mixedcase
        int256 amountX10_18,
        uint8 decimals
    ) external pure returns (bool) {
        return settlementToken.gte(amountX10_18, decimals);
    }

    function testGt(
        uint256 settlementToken,
        // solhint-disable-next-line var-name-mixedcase
        uint256 amountX10_18,
        uint8 decimals
    ) external pure returns (bool) {
        return settlementToken.gt(amountX10_18, decimals);
    }

    function testGt(
        int256 settlementToken,
        // solhint-disable-next-line var-name-mixedcase
        int256 amountX10_18,
        uint8 decimals
    ) external pure returns (bool) {
        return settlementToken.gt(amountX10_18, decimals);
    }

    function testParseSettlementToken(uint256 amount, uint8 decimals) external pure returns (uint256) {
        return amount.parseSettlementToken(decimals);
    }

    function testParseSettlementToken(int256 amount, uint8 decimals) external pure returns (int256) {
        return amount.parseSettlementToken(decimals);
    }

    function testFormatSettlementToken(uint256 amount, uint8 decimals) external pure returns (uint256) {
        return amount.formatSettlementToken(decimals);
    }

    function testFormatSettlementToken(int256 amount, uint8 decimals) external pure returns (int256) {
        return amount.formatSettlementToken(decimals);
    }

    function testConvertTokenDecimals(
        uint256 amount,
        uint8 fromDecimals,
        uint8 toDecimals
    ) external pure returns (uint256) {
        return amount.convertTokenDecimals(fromDecimals, toDecimals);
    }

    function testConvertTokenDecimals(
        int256 amount,
        uint8 fromDecimals,
        uint8 toDecimals
    ) external pure returns (int256) {
        return amount.convertTokenDecimals(fromDecimals, toDecimals);
    }
}
