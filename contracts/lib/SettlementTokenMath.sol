pragma solidity 0.7.6;

import { SafeMath } from "@openzeppelin/contracts/math/SafeMath.sol";
import { SignedSafeMath } from "@openzeppelin/contracts/math/SignedSafeMath.sol";
import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

// @dev decimals of settlementToken token MUST be less than 18
library SettlementTokenMath {
    using SafeMath for uint256;
    using SignedSafeMath for int256;

    // @dev return amount with settlementToken's decimal
    function addS(
        uint256 settlementToken,
        uint256 amountIn10_18,
        uint8 decimals
    ) internal view returns (uint256) {
        return formatSettlementToken(parseSettlementToken(settlementToken, decimals).add(amountIn10_18), decimals);
    }

    // @dev return amount with settlementToken's decimal
    function addS(
        int256 settlementToken,
        int256 amountIn10_18,
        uint8 decimals
    ) internal view returns (int256) {
        return formatSettlementToken(parseSettlementToken(settlementToken, decimals).add(amountIn10_18), decimals);
    }

    // @dev return amount with settlementToken's decimal
    function subS(
        uint256 settlementToken,
        uint256 amountIn10_18,
        uint8 decimals
    ) internal view returns (uint256) {
        return formatSettlementToken(parseSettlementToken(settlementToken, decimals).sub(amountIn10_18), decimals);
    }

    // @dev return amount with settlementToken's decimal
    function subS(
        int256 settlementToken,
        int256 amountIn10_18,
        uint8 decimals
    ) internal view returns (int256) {
        return formatSettlementToken(parseSettlementToken(settlementToken, decimals).sub(amountIn10_18), decimals);
    }

    function lte(
        uint256 settlementToken,
        uint256 amountIn10_18,
        uint8 decimals
    ) internal view returns (bool) {
        return parseSettlementToken(settlementToken, decimals) <= amountIn10_18;
    }

    function lte(
        int256 settlementToken,
        int256 amountIn10_18,
        uint8 decimals
    ) internal view returns (bool) {
        return parseSettlementToken(settlementToken, decimals) <= amountIn10_18;
    }

    function lt(
        uint256 settlementToken,
        uint256 amountIn10_18,
        uint8 decimals
    ) internal view returns (bool) {
        return parseSettlementToken(settlementToken, decimals) < amountIn10_18;
    }

    function lt(
        int256 settlementToken,
        int256 amountIn10_18,
        uint8 decimals
    ) internal view returns (bool) {
        return parseSettlementToken(settlementToken, decimals) < amountIn10_18;
    }

    function gt(
        uint256 settlementToken,
        uint256 amountIn10_18,
        uint8 decimals
    ) internal view returns (bool) {
        return parseSettlementToken(settlementToken, decimals) > amountIn10_18;
    }

    function gt(
        int256 settlementToken,
        int256 amountIn10_18,
        uint8 decimals
    ) internal view returns (bool) {
        return parseSettlementToken(settlementToken, decimals) > amountIn10_18;
    }

    function gte(
        uint256 settlementToken,
        uint256 amountIn10_18,
        uint8 decimals
    ) internal view returns (bool) {
        return parseSettlementToken(settlementToken, decimals) >= amountIn10_18;
    }

    function gte(
        int256 settlementToken,
        int256 amountIn10_18,
        uint8 decimals
    ) internal view returns (bool) {
        return parseSettlementToken(settlementToken, decimals) >= amountIn10_18;
    }

    // returns number with 18 decimals
    function parseSettlementToken(uint256 amount, uint8 decimals) internal pure returns (uint256) {
        return amount.mul(10**(18 - decimals));
    }

    // returns number with 18 decimals
    function parseSettlementToken(int256 amount, uint8 decimals) internal pure returns (int256) {
        return amount.mul(int256(10**(18 - decimals)));
    }

    // returns number with settlementToken's decimals
    function formatSettlementToken(uint256 amount, uint8 decimals) internal pure returns (uint256) {
        return amount.div(10**(18 - decimals));
    }

    // returns number with settlementToken's decimals
    function formatSettlementToken(int256 amount, uint8 decimals) internal pure returns (int256) {
        return amount.div(int256(10**(18 - decimals)));
    }
}
