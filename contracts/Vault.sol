// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;

import { AddressUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/AddressUpgradeable.sol";
import { ContextUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/ContextUpgradeable.sol";
import { ReentrancyGuardUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import { SafeMathUpgradeable } from "@openzeppelin/contracts-upgradeable/math/SafeMathUpgradeable.sol";
import { SignedSafeMathUpgradeable } from "@openzeppelin/contracts-upgradeable/math/SignedSafeMathUpgradeable.sol";
import { TransferHelper } from "@uniswap/lib/contracts/libraries/TransferHelper.sol";
import { BaseRelayRecipient } from "./gsn/BaseRelayRecipient.sol";
import { IERC20Metadata } from "./interface/IERC20Metadata.sol";
import { ISettlement } from "./interface/ISettlement.sol";
import { PerpSafeCast } from "./lib/PerpSafeCast.sol";
import { ClearingHouse } from "./ClearingHouse.sol";
import { SettlementTokenMath } from "./lib/SettlementTokenMath.sol";
import { PerpMath } from "./lib/PerpMath.sol";
import { IVault } from "./interface/IVault.sol";
import { OwnerPausable } from "./base/OwnerPausable.sol";
import { InsuranceFund } from "./InsuranceFund.sol";
import "hardhat/console.sol";

contract Vault is ReentrancyGuardUpgradeable, OwnerPausable, BaseRelayRecipient, IVault {
    using SafeMathUpgradeable for uint256;
    using PerpSafeCast for uint256;
    using PerpSafeCast for int256;
    using SignedSafeMathUpgradeable for int256;
    using SettlementTokenMath for uint256;
    using SettlementTokenMath for int256;
    using PerpMath for int256;
    using AddressUpgradeable for address;

    event Deposited(address indexed collateralToken, address indexed trader, uint256 amount);
    event Withdrawn(address indexed collateralToken, address indexed trader, uint256 amount);
    event ClearingHouseUpdated(address clearingHouse);
    event InsuranceFundUpdated(address insuranceFund);

    // not used here, due to inherit from BaseRelayRecipient
    string public override versionRecipient;

    // TODO should be immutable, check how to achieve this in oz upgradeable framework.
    address public settlementToken;

    address public clearingHouse;
    address public insuranceFund;

    // cached the settlement token's decimal for gas optimization
    // owner must ensure the settlement token's decimal is not immutable
    // TODO should be immutable, check how to achieve this in oz upgradeable framework.
    uint8 public override decimals;

    uint256 public totalDebt;

    address[] internal _collateralTokens;

    // key: trader, token address
    mapping(address => mapping(address => int256)) internal _balance;

    // key: token
    // TODO: change bool to collateral factor
    mapping(address => bool) internal _collateralTokenMap;

    function initialize(address settlementTokenArg) external initializer {
        // V_ANC: SettlementToken address is not contract
        require(settlementTokenArg.isContract(), "V_ANC");

        __ReentrancyGuard_init();
        __OwnerPausable_init();

        // invalid settlementToken decimals
        require(IERC20Metadata(settlementTokenArg).decimals() <= 18, "V_ISTD");

        // update states
        decimals = IERC20Metadata(settlementTokenArg).decimals();
        settlementToken = settlementTokenArg;
        _addCollateralToken(settlementTokenArg);

        // we don't use this var
        versionRecipient = "2.0.0";
    }

    //
    // OWNER SETTER
    //
    function setClearingHouse(address clearingHouseArg) external onlyOwner {
        // V_ANC: ClearingHouse address is not contract
        require(clearingHouseArg.isContract(), "V_ANC");
        clearingHouse = clearingHouseArg;
        emit ClearingHouseUpdated(clearingHouseArg);
    }

    function setInsuranceFund(address insuranceFundArg) external onlyOwner {
        // V_IFNC: InsuranceFund address is not contract
        require(insuranceFundArg.isContract(), "V_IFNC");
        insuranceFund = insuranceFundArg;
        emit InsuranceFundUpdated(insuranceFundArg);
    }

    function setTrustedForwarder(address trustedForwarderArg) external onlyOwner {
        // V_ANC: TrustedForwarder address is not contract
        require(trustedForwarderArg.isContract(), "V_ANC");
        _setTrustedForwarder(trustedForwarderArg);
    }

    //
    // EXTERNAL
    //
    function deposit(address token, uint256 amount) external whenNotPaused nonReentrant {
        // collateralToken not found
        require(_collateralTokenMap[token], "V_CNF");

        address from = _msgSender();

        _increaseBalance(from, token, amount);

        // for deflationary token,
        // amount may not be equal to the received amount due to the charged (and burned) transaction fee
        uint256 balanceBefore = IERC20Metadata(token).balanceOf(from);
        TransferHelper.safeTransferFrom(token, from, address(this), amount);
        // balance amount inconsistent
        require(balanceBefore.sub(IERC20Metadata(token).balanceOf(from)) == amount, "V_BAI");

        emit Deposited(token, from, amount);
    }

    function withdraw(address token, uint256 amount) external whenNotPaused nonReentrant {
        address to = _msgSender();

        // settle ClearingHouse's owedRealizedPnl to collateral
        int256 pnl = ClearingHouse(clearingHouse).settle(to);
        if (pnl > 0) {
            _increaseBalance(to, settlementToken, pnl.toUint256());
        } else if (pnl < 0) {
            _decreaseBalance(to, settlementToken, pnl.abs());
        }

        require(_getFreeCollateral(to) >= amount, "V_NEFC");
        _decreaseBalance(to, token, amount);

        // borrow settlement token from insurance fund if token balance is not enough
        if (token == settlementToken) {
            uint256 vaultBalance = IERC20Metadata(token).balanceOf(address(this));
            if (vaultBalance < amount) {
                uint256 borrowAmount = amount - vaultBalance;
                InsuranceFund(insuranceFund).borrow(borrowAmount);
                totalDebt += borrowAmount;
            }
        }

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
        return _getFreeCollateral(trader);
    }

    function _addCollateralToken(address token) internal {
        // collateral token existed
        require(!_collateralTokenMap[token], "V_CTE");
        _collateralTokenMap[token] = true;
        _collateralTokens.push(token);
    }

    function _increaseBalance(
        address trader,
        address token,
        uint256 amount
    ) internal {
        _balance[trader][token] = _getBalance(trader, token).add(amount.toInt256());
    }

    function _decreaseBalance(
        address trader,
        address token,
        uint256 amount
    ) internal {
        _balance[trader][token] = _getBalance(trader, token).sub(amount.toInt256());
    }

    function _getBalance(address trader, address token) internal view returns (int256) {
        return _balance[trader][token];
    }

    function _getTotalCollateralValue(address trader) internal view returns (int256) {
        int256 balance = balanceOf(trader);
        int256 owedRealizedPnl = ClearingHouse(clearingHouse).getOwedRealizedPnl(trader);
        return balance.addS(owedRealizedPnl, decimals);
    }

    // there are three configurations for different insolvency risk tolerance: conservative, moderate, aggressive
    // we will start with the conservative one, then gradually change it to more aggressive ones
    // to increase capital efficiency.
    function _getFreeCollateral(address trader) private view returns (uint256) {
        // conservative config: freeCollateral = max(min(collateral, accountValue) - imReq, 0)
        int256 totalCollateralValue = _getTotalCollateralValue(trader);
        int256 accountValue = ClearingHouse(clearingHouse).getAccountValue(trader);
        uint256 totalInitialMarginRequirement = ClearingHouse(clearingHouse).getTotalInitialMarginRequirement(trader);
        int256 freeCollateral =
            PerpMath.min(totalCollateralValue, accountValue).subS(totalInitialMarginRequirement.toInt256(), decimals);
        return PerpMath.max(freeCollateral, 0).toUint256();

        // moderate config: freeCollateral = max(min(collateral, accountValue - imReq), 0)
        // return PerpMath.max(PerpMath.min(collateralValue, accountValue.subS(totalImReq, decimals)), 0).toUint256();

        // aggressive config: freeCollateral = max(accountValue - imReq, 0)
        // TODO note that aggressive model depends entirely on unrealizedPnl, which depends on the index price, for
        //  calculating freeCollateral. We should implement some sort of safety check before using this model;
        //  otherwise a trader could drain the entire vault if the index price deviates significantly.
        // return PerpMath.max(accountValue.subS(totalImReq, decimals), 0).toUint256()
    }

    /// @inheritdoc BaseRelayRecipient
    function _msgSender() internal view override(BaseRelayRecipient, OwnerPausable) returns (address payable) {
        return super._msgSender();
    }

    /// @inheritdoc BaseRelayRecipient
    function _msgData() internal view override(BaseRelayRecipient, OwnerPausable) returns (bytes memory) {
        return super._msgData();
    }
}
