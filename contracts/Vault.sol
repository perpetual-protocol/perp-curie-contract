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
import { PerpOwnable } from "./base/PerpOwnable.sol";

contract Vault is ReentrancyGuard, PerpOwnable, BaseRelayRecipient, IVault {
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
        TransferHelper.safeTransferFrom(token, from, address(this), amount);

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

    // TODO reduce external calls
    // min(collateral, accountValue) - (totalBaseDebt + totalQuoteDebt) * imRatio
    function _getFreeCollateral(address trader) internal view returns (uint256) {
        return
            PerpMath
                .max(ClearingHouse(clearingHouse).getFreeCollateralWithBalance(trader, balanceOf(trader)), 0)
                .toUint256();
    }

    // @inheritdoc BaseRelayRecipient
    function _msgSender() internal view override(BaseRelayRecipient, Context) returns (address payable) {
        return super._msgSender();
    }

    // @inheritdoc BaseRelayRecipient
    function _msgData() internal view override(BaseRelayRecipient, Context) returns (bytes memory) {
        return super._msgData();
    }
}
