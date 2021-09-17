// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;

import { MathUpgradeable } from "@openzeppelin/contracts-upgradeable/math/MathUpgradeable.sol";
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
import { SettlementTokenMath } from "./lib/SettlementTokenMath.sol";
import { PerpMath } from "./lib/PerpMath.sol";
import { IVault } from "./interface/IVault.sol";
import { OwnerPausable } from "./base/OwnerPausable.sol";
import { IInsuranceFund } from "./interface/IInsuranceFund.sol";
import { AccountBalance } from "./AccountBalance.sol";
import { ClearingHouseConfig } from "./ClearingHouseConfig.sol";

contract Vault is ReentrancyGuardUpgradeable, OwnerPausable, BaseRelayRecipient, IVault {
    using SafeMathUpgradeable for uint256;
    using PerpSafeCast for uint256;
    using PerpSafeCast for int256;
    using SignedSafeMathUpgradeable for int256;
    using SettlementTokenMath for uint256;
    using SettlementTokenMath for int256;
    using PerpMath for int256;
    using PerpMath for uint256;
    using AddressUpgradeable for address;

    event Deposited(address indexed collateralToken, address indexed trader, uint256 amount);
    event Withdrawn(address indexed collateralToken, address indexed trader, uint256 amount);

    // ------ immutable states ------

    // cached the settlement token's decimal for gas optimization
    uint8 public override decimals;

    address public settlementToken;

    // ------ ^^^^^^^^^^^^^^^^ ------

    address public clearingHouseConfig;
    address public accountBalance;
    address public insuranceFund;

    uint256 public totalDebt;

    // not used here, due to inherit from BaseRelayRecipient
    string public override versionRecipient;

    address[] internal _collateralTokens;

    // key: trader, token address
    mapping(address => mapping(address => int256)) internal _balance;

    // key: token
    // TODO: change bool to collateral factor
    mapping(address => bool) internal _collateralTokenMap;

    function initialize(
        address insuranceFundArg,
        address clearingHouseConfigArg,
        address accountBalanceArg
    ) external initializer {
        // V_IFNC: InsuranceFund address is not contract
        require(insuranceFundArg.isContract(), "V_IFNC");
        address settlementTokenArg = IInsuranceFund(insuranceFundArg).token();
        // V_ANC: SettlementToken address is not contract
        require(settlementTokenArg.isContract(), "V_STNC");
        // invalid settlementToken decimals
        require(IERC20Metadata(settlementTokenArg).decimals() <= 18, "V_ISTD");

        // ClearingHouseConfig address is not contract
        require(clearingHouseConfigArg.isContract(), "V_CHCNC");
        // accountBalance address is not contract
        require(accountBalanceArg.isContract(), "V_ABNC");

        __ReentrancyGuard_init();
        __OwnerPausable_init();

        // update states
        decimals = IERC20Metadata(settlementTokenArg).decimals();
        settlementToken = settlementTokenArg;
        insuranceFund = insuranceFundArg;
        _addCollateralToken(settlementTokenArg);
        clearingHouseConfig = clearingHouseConfigArg;
        accountBalance = accountBalanceArg;

        // we don't use this var
        versionRecipient = "2.0.0";
    }

    //
    // OWNER SETTER
    //

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

        _modifyBalance(from, token, amount.toInt256());

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

        int256 pnl = AccountBalance(accountBalance).settle(to);
        // V_NEFC: not enough freeCollateral
        require(getFreeCollateral(to).toInt256().add(pnl) >= amount.toInt256(), "V_NEFC");

        // borrow settlement token from insurance fund if token balance is not enough
        if (token == settlementToken) {
            uint256 vaultBalance = IERC20Metadata(token).balanceOf(address(this));
            if (vaultBalance < amount) {
                uint256 borrowAmount = amount - vaultBalance;
                IInsuranceFund(insuranceFund).borrow(borrowAmount);
                totalDebt += borrowAmount;
            }
        }

        // settle AccountBalance's owedRealizedPnl to collateral
        _modifyBalance(to, token, pnl.sub(amount.toInt256()));
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

    function getFreeCollateral(address trader) public view returns (uint256) {
        return PerpMath.max(getFreeCollateralByRatio(trader, _getImRatio()), 0).toUint256();
    }

    //
    // INTERNAL
    //

    function _addCollateralToken(address token) internal {
        // collateral token existed
        require(!_collateralTokenMap[token], "V_CTE");
        _collateralTokenMap[token] = true;
        _collateralTokens.push(token);
    }

    function _modifyBalance(
        address trader,
        address token,
        int256 amount
    ) internal {
        _balance[trader][token] = _getBalance(trader, token).add(amount);
    }

    function _getBalance(address trader, address token) internal view returns (int256) {
        return _balance[trader][token];
    }

    function _getTotalCollateralValue(address trader) internal view returns (int256) {
        int256 balance = balanceOf(trader);
        int256 owedRealizedPnl = AccountBalance(accountBalance).getOwedRealizedPnl(trader);
        return balance.addS(owedRealizedPnl, decimals);
    }

    // there are three configurations for different insolvency risk tolerance: conservative, moderate, aggressive
    // we will start with the conservative one, then gradually change it to more aggressive ones
    // to increase capital efficiency.
    function getFreeCollateralByRatio(address trader, uint24 ratio) public view override returns (int256) {
        // conservative config: freeCollateral = max(min(collateral, accountValue) - imReq, 0)
        int256 totalCollateralValue = _getTotalCollateralValue(trader);

        // accountValue = totalCollateralValue + totalUnrealizedPnl, in the settlement token's decimals

        int256 accountValue =
            totalCollateralValue.addS(AccountBalance(accountBalance).getTotalUnrealizedPnl(trader), decimals);
        uint256 totalInitialMarginRequirement = _getTotalMarginRequirement(trader, ratio);
        return
            PerpMath.min(totalCollateralValue, accountValue).subS(totalInitialMarginRequirement.toInt256(), decimals);

        // moderate config: freeCollateral = max(min(collateral, accountValue - imReq), 0)
        // return PerpMath.max(PerpMath.min(collateralValue, accountValue.subS(totalImReq, decimals)), 0).toUint256();

        // aggressive config: freeCollateral = max(accountValue - imReq, 0)
        // TODO note that aggressive model depends entirely on unrealizedPnl, which depends on the index price, for
        //  calculating freeCollateral. We should implement some sort of safety check before using this model;
        //  otherwise a trader could drain the entire vault if the index price deviates significantly.
        // return PerpMath.max(accountValue.subS(totalImReq, decimals), 0).toUint256()
    }

    // return decimals 18
    function _getTotalMarginRequirement(address trader, uint24 ratio) internal view returns (uint256) {
        uint256 totalDebtValue = AccountBalance(accountBalance).getTotalDebtValue(trader);
        return totalDebtValue.mulRatio(ratio);
    }

    function _getImRatio() internal view returns (uint24) {
        return ClearingHouseConfig(clearingHouseConfig).imRatio();
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
