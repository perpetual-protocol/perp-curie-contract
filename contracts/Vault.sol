// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;

import { Context } from "@openzeppelin/contracts/utils/Context.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { Math } from "@openzeppelin/contracts/math/Math.sol";
import { SafeMath } from "@openzeppelin/contracts/math/SafeMath.sol";
import { SignedSafeMath } from "@openzeppelin/contracts/math/SignedSafeMath.sol";
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

contract Vault is ReentrancyGuard, OwnerPausable, BaseRelayRecipient, IVault {
    using SafeMath for uint256;
    using PerpSafeCast for uint256;
    using PerpSafeCast for int256;
    using SignedSafeMath for int256;
    using SettlementTokenMath for uint256;
    using SettlementTokenMath for int256;
    using PerpMath for int256;

    event Deposited(address indexed collateralToken, address indexed trader, uint256 amount);
    event Withdrawn(address indexed collateralToken, address indexed trader, uint256 amount);
    event ClearingHouseUpdated(address clearingHouse);
    event TrustedForwarderUpdated(address trustedForwarder);

    // not used here, due to inherit from BaseRelayRecipient
    string public override versionRecipient;

    address public immutable settlementToken;
    address public clearingHouse;

    // cached the settlement token's decimal for gas optimization
    // owner must ensure the settlement token's decimal is not immutable
    uint8 public immutable override decimals;

    address[] internal _collateralTokens;

    // key: trader, token address
    mapping(address => mapping(address => int256)) internal _balance;

    // key: token
    // TODO: change bool to collateral factor
    mapping(address => bool) internal _collateralTokenMap;

    constructor(address settlementTokenArg) {
        // invalid settlementToken decimals
        require(IERC20Metadata(settlementTokenArg).decimals() <= 18, "V_ISTD");

        // update states
        decimals = IERC20Metadata(settlementTokenArg).decimals();
        settlementToken = settlementTokenArg;
        _addCollateralToken(settlementTokenArg);
    }

    //
    // OWNER SETTER
    //
    function setClearingHouse(address clearingHouseArg) external onlyOwner {
        // invalid ClearingHouse address
        require(clearingHouseArg != address(0), "V_ICHA");
        clearingHouse = clearingHouseArg;
        emit ClearingHouseUpdated(clearingHouseArg);
    }

    function setTrustedForwarder(address trustedForwarderArg) external onlyOwner {
        // invalid trusted forwarder address
        require(trustedForwarderArg != address(0), "V_ITFA");
        trustedForwarder = trustedForwarderArg;
        emit TrustedForwarderUpdated(trustedForwarderArg);
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

    function _liquidate(
        address trader,
        address collateralToken,
        uint256 amount
    ) internal {
        revert("TBD");
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
    function _msgSender() internal view override(BaseRelayRecipient, Context) returns (address payable) {
        return super._msgSender();
    }

    /// @inheritdoc BaseRelayRecipient
    function _msgData() internal view override(BaseRelayRecipient, Context) returns (bytes memory) {
        return super._msgData();
    }
}
