// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { Math } from "@openzeppelin/contracts/math/Math.sol";
import { SafeMath } from "@openzeppelin/contracts/math/SafeMath.sol";
import { SignedSafeMath } from "@openzeppelin/contracts/math/SignedSafeMath.sol";
import { TransferHelper } from "@uniswap/lib/contracts/libraries/TransferHelper.sol";
import { IERC20Metadata } from "./interface/IERC20Metadata.sol";
import { ISettlement } from "./interface/ISettlement.sol";
import { PerpSafeCast } from "./lib/PerpSafeCast.sol";
import { ClearingHouse } from "./ClearingHouse.sol";
import { SettlementTokenMath } from "./lib/SettlementTokenMath.sol";
import { PerpMath } from "./lib/PerpMath.sol";
import { IVault } from "./interface/IVault.sol";

contract Vault is ReentrancyGuard, Ownable, IVault {
    using SafeMath for uint256;
    using PerpSafeCast for uint256;
    using PerpSafeCast for int256;
    using SignedSafeMath for int256;
    using SettlementTokenMath for uint256;
    using SettlementTokenMath for int256;
    using PerpMath for int256;

    event Deposited(address indexed collateralToken, address indexed trader, uint256 amount);
    event Withdrawn(address indexed collateralToken, address indexed trader, uint256 amount);

    address public immutable settlementToken;
    address public clearingHouse;

    uint8 public immutable override decimals;

    // those 4 are not used until multi collateral is implemented
    // uint256 public maxCloseFactor;
    // uint256 public minCloseFactor;
    // uint256 public liquidationDiscount;
    // address[] private _assetLiquidationOrder;

    // key: trader, token address
    mapping(address => mapping(address => int256)) private _balance;

    // key: token
    // TODO: change bool to collateral factor
    mapping(address => bool) private _collateralTokenMap;
    address[] private _collateralTokens;

    constructor(address settlementTokenArg) {
        settlementToken = settlementTokenArg;
        // invalid settlementToken decimals
        require(IERC20Metadata(settlementTokenArg).decimals() <= 18, "V_ISTD");
        decimals = IERC20Metadata(settlementTokenArg).decimals();

        _addCollateralToken(settlementTokenArg);
    }

    function setClearingHouse(address clearingHouseArg) external onlyOwner {
        // invalid ClearingHouse address
        require(clearingHouseArg != address(0), "V_ICHA");
        // TODO add event
        clearingHouse = clearingHouseArg;
    }

    function deposit(address token, uint256 amount) external nonReentrant() {
        // collateralToken not found
        require(_collateralTokenMap[token], "V_CNF");

        address from = _msgSender();

        _increaseBalance(from, token, amount);
        TransferHelper.safeTransferFrom(token, from, address(this), amount);

        emit Deposited(token, from, amount);
    }

    function withdraw(address token, uint256 amount) external nonReentrant() {
        // invalid ClearingHouse address
        require(clearingHouse != address(0), "V_ICHA");

        address to = _msgSender();

        // settle ClearingHouse's owedRealizedPnl to collateral
        int256 pnl = ClearingHouse(clearingHouse).settle(to);
        if (pnl > 0) {
            _increaseBalance(to, settlementToken, pnl.toUint256());
        } else if (pnl < 0) {
            _decreaseBalance(to, settlementToken, pnl.abs());
        }

        // V_NEB: not enough balance
        require(_getBalance(to, token) >= amount.toInt256(), "V_NEB");
        _decreaseBalance(to, token, amount);

        // V_NEFC: not enough free collateral
        require(_getFreeCollateral(to) >= 0, "V_NEFC");
        TransferHelper.safeTransfer(token, to, amount);
        emit Withdrawn(token, to, amount);
    }

    // expensive call
    function balanceOf(address trader) public view override returns (int256) {
        int256 settlementTokenValue;
        for (uint256 i = 0; i < _collateralTokens.length; i++) {
            address token = _collateralTokens[i];
            if (settlementToken != token) {
                revert("TBD - token twap * trader's balance");
            }
            // is settlement token
            settlementTokenValue = settlementTokenValue.add(_getBalance(trader, token));
        }

        return settlementTokenValue;
    }

    function getFreeCollateral(address trader) external view returns (uint256) {
        int256 freeCollateral = _getFreeCollateral(trader);
        return freeCollateral > 0 ? freeCollateral.toUint256() : 0;
    }

    function _addCollateralToken(address token) private {
        // collateral token existed
        require(!_collateralTokenMap[token], "V_CTE");
        _collateralTokenMap[token] = true;
        _collateralTokens.push(token);
    }

    function _increaseBalance(
        address trader,
        address token,
        uint256 amount
    ) private {
        _balance[trader][token] = _getBalance(trader, token).add(amount.toInt256());
    }

    function _decreaseBalance(
        address trader,
        address token,
        uint256 amount
    ) private {
        _balance[trader][token] = _getBalance(trader, token).sub(amount.toInt256());
    }

    function _liquidate(
        address trader,
        address collateralToken,
        uint256 amount
    ) private {
        revert("TBD");
    }

    function _getBalance(address trader, address token) private view returns (int256) {
        return _balance[trader][token];
    }

    // TODO reduce external calls
    // min(collateral, accountValue) - (totalBaseDebt + totalQuoteDebt) * imRatio
    function _getFreeCollateral(address trader) private view returns (int256) {
        // totalOpenOrderMarginRequirement = (totalBaseDebtValue + totalQuoteDebtValue) * imRatio
        uint256 openOrderMarginRequirement = ClearingHouse(clearingHouse).getTotalOpenOrderMarginRequirement(trader);
        int256 pendingFundingPayment = ClearingHouse(clearingHouse).getAllPendingFundingPayment(trader);

        // accountValue = totalCollateralValue + totalMarketPnl
        int256 owedRealizedPnl = ClearingHouse(clearingHouse).getOwedRealizedPnl(trader);
        int256 collateralValue = balanceOf(trader).addS(owedRealizedPnl.sub(pendingFundingPayment), decimals);
        int256 totalMarketPnl = ClearingHouse(clearingHouse).getTotalUnrealizedPnl(trader);
        int256 accountValue = collateralValue.addS(totalMarketPnl, decimals);

        // collateral
        int256 min = collateralValue < accountValue ? collateralValue : accountValue;

        return min.subS(openOrderMarginRequirement.toInt256(), decimals);
    }
}
