// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;
pragma abicoder v2;

import { OwnerPausable } from "./base/OwnerPausable.sol";
import { CollateralManagerStorageV2 } from "./storage/CollateralManagerStorage.sol";
import { AddressUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/AddressUpgradeable.sol";
import { IPriceFeed } from "@perp/perp-oracle-contract/contracts/interface/IPriceFeed.sol";
import { Collateral } from "./lib/Collateral.sol";
import { ICollateralManager } from "./interface/ICollateralManager.sol";
import { IClearingHouseConfig } from "./interface/IClearingHouseConfig.sol";
import { IVault } from "./interface/IVault.sol";
import { SafeMathUpgradeable } from "@openzeppelin/contracts-upgradeable/math/SafeMathUpgradeable.sol";

contract CollateralManager is ICollateralManager, OwnerPausable, CollateralManagerStorageV2 {
    using AddressUpgradeable for address;
    using SafeMathUpgradeable for uint256;

    uint24 private constant _ONE_HUNDRED_PERCENT_RATIO = 1e6;

    //
    // MODIFIER
    //

    modifier checkRatio(uint24 ratio) {
        // CM_IR: invalid ratio, should be in [0, 1]
        require(ratio <= _ONE_HUNDRED_PERCENT_RATIO, "CM_IR");
        _;
    }

    //
    // EXTERNAL NON-VIEW
    //

    function initialize(
        address clearingHouseConfigArg,
        address vaultArg,
        uint8 maxCollateralTokensPerAccountArg,
        uint24 debtNonSettlementTokenValueRatioArg,
        uint24 liquidationRatioArg,
        uint24 mmRatioBufferArg,
        uint24 clInsuranceFundFeeRatioArg,
        uint256 debtThresholdArg,
        uint256 collateralValueDustArg
    )
        external
        initializer
        checkRatio(debtNonSettlementTokenValueRatioArg)
        checkRatio(liquidationRatioArg)
        checkRatio(clInsuranceFundFeeRatioArg)
    {
        // CM_CHCNC: clearing house config is not contract
        require(clearingHouseConfigArg.isContract(), "CM_CHCNC");
        // CM_VNC: vault is not contract
        require(vaultArg.isContract(), "CM_VNC");

        __OwnerPausable_init();

        _clearingHouseConfig = clearingHouseConfigArg;
        _vault = vaultArg;
        _maxCollateralTokensPerAccount = maxCollateralTokensPerAccountArg;
        _debtNonSettlementTokenValueRatio = debtNonSettlementTokenValueRatioArg;
        _liquidationRatio = liquidationRatioArg;

        requireValidCollateralMmRatio(mmRatioBufferArg);
        _mmRatioBuffer = mmRatioBufferArg;

        _clInsuranceFundFeeRatio = clInsuranceFundFeeRatioArg;
        _debtThreshold = debtThresholdArg;
        _collateralValueDust = collateralValueDustArg;

        emit ClearingHouseConfigChanged(clearingHouseConfigArg);
        emit VaultChanged(vaultArg);
        emit MaxCollateralTokensPerAccountChanged(maxCollateralTokensPerAccountArg);
        emit MmRatioBufferChanged(mmRatioBufferArg);
        emit DebtNonSettlementTokenValueRatioChanged(debtNonSettlementTokenValueRatioArg);
        emit LiquidationRatioChanged(liquidationRatioArg);
        emit CLInsuranceFundFeeRatioChanged(clInsuranceFundFeeRatioArg);
        emit DebtThresholdChanged(debtThresholdArg);
        emit CollateralValueDustChanged(collateralValueDustArg);
    }

    function addCollateral(address token, Collateral.Config memory config)
        external
        checkRatio(config.collateralRatio)
        checkRatio(config.discountRatio)
        onlyOwner
    {
        // CM_CTE: collateral token already exists
        require(!isCollateral(token), "CM_CTE");
        // CM_CTNC: collateral token is not contract
        require(token.isContract(), "CM_CTNC");
        // CM_PFNC: price feed is not contract
        require(config.priceFeed.isContract(), "CM_PFNC");
        // CM_CIS: collateral token is settlement token
        require(IVault(_vault).getSettlementToken() != token, "CM_CIS");

        _collateralConfigMap[token] = config;
        emit CollateralAdded(token, config.priceFeed, config.collateralRatio, config.discountRatio, config.depositCap);
    }

    function setPriceFeed(address token, address priceFeed) external onlyOwner {
        _requireIsCollateral(token);
        // CM_PFNC: price feed is not contract
        require(priceFeed.isContract(), "CM_PFNC");

        _collateralConfigMap[token].priceFeed = priceFeed;
        emit PriceFeedChanged(token, priceFeed);
    }

    function setCollateralRatio(address token, uint24 collateralRatio) external checkRatio(collateralRatio) onlyOwner {
        _requireIsCollateral(token);

        _collateralConfigMap[token].collateralRatio = collateralRatio;
        emit CollateralRatioChanged(token, collateralRatio);
    }

    function setDiscountRatio(address token, uint24 discountRatio) external checkRatio(discountRatio) onlyOwner {
        _requireIsCollateral(token);

        _collateralConfigMap[token].discountRatio = discountRatio;
        emit DiscountRatioChanged(token, discountRatio);
    }

    function setDepositCap(address token, uint256 depositCap) external onlyOwner {
        _requireIsCollateral(token);
        _collateralConfigMap[token].depositCap = depositCap;
        emit DepositCapChanged(token, depositCap);
    }

    function setMaxCollateralTokensPerAccount(uint8 maxCollateralTokensPerAccount) external onlyOwner {
        _maxCollateralTokensPerAccount = maxCollateralTokensPerAccount;
        emit MaxCollateralTokensPerAccountChanged(maxCollateralTokensPerAccount);
    }

    function setMmRatioBuffer(uint24 mmRatioBuffer) external onlyOwner {
        requireValidCollateralMmRatio(mmRatioBuffer);

        _mmRatioBuffer = mmRatioBuffer;
        emit MmRatioBufferChanged(mmRatioBuffer);
    }

    function setDebtNonSettlementTokenValueRatio(uint24 debtNonSettlementTokenValueRatio)
        external
        checkRatio(debtNonSettlementTokenValueRatio)
        onlyOwner
    {
        _debtNonSettlementTokenValueRatio = debtNonSettlementTokenValueRatio;
        emit DebtNonSettlementTokenValueRatioChanged(debtNonSettlementTokenValueRatio);
    }

    function setLiquidationRatio(uint24 liquidationRatio) external checkRatio(liquidationRatio) onlyOwner {
        _liquidationRatio = liquidationRatio;
        emit LiquidationRatioChanged(liquidationRatio);
    }

    function setCLInsuranceFundFeeRatio(uint24 clInsuranceFundFeeRatio)
        external
        checkRatio(clInsuranceFundFeeRatio)
        onlyOwner
    {
        _clInsuranceFundFeeRatio = clInsuranceFundFeeRatio;
        emit CLInsuranceFundFeeRatioChanged(clInsuranceFundFeeRatio);
    }

    function setDebtThreshold(uint256 debtThreshold) external onlyOwner {
        // CM_ZDT: zero debt threshold
        require(debtThreshold != 0, "CM_ZDT");

        _debtThreshold = debtThreshold;
        emit DebtThresholdChanged(debtThreshold);
    }

    function setWhitelistedDebtThreshold(address trader, uint256 whitelistedDebtThreshold) external onlyOwner {
        uint256 whitelistedDebtThresholdBefore = _whitelistedDebtThresholdMap[trader];
        _whitelistedDebtThresholdMap[trader] = whitelistedDebtThreshold;
        _totalWhitelistedDebtThreshold = whitelistedDebtThresholdBefore > whitelistedDebtThreshold
            ? _totalWhitelistedDebtThreshold.sub(whitelistedDebtThresholdBefore - whitelistedDebtThreshold)
            : _totalWhitelistedDebtThreshold.add(whitelistedDebtThreshold - whitelistedDebtThresholdBefore);

        emit WhitelistedDebtThresholdChanged(trader, whitelistedDebtThreshold);
    }

    /// @dev Same decimals as the settlement token
    function setCollateralValueDust(uint256 collateralValueDust) external onlyOwner {
        _collateralValueDust = collateralValueDust;
        emit CollateralValueDustChanged(collateralValueDust);
    }

    //
    // EXTERNAL VIEW
    //

    /// @inheritdoc ICollateralManager
    function getClearingHouseConfig() external view override returns (address) {
        return _clearingHouseConfig;
    }

    /// @inheritdoc ICollateralManager
    function getVault() external view override returns (address) {
        return _vault;
    }

    /// @inheritdoc ICollateralManager
    function getCollateralConfig(address token) external view override returns (Collateral.Config memory) {
        return _collateralConfigMap[token];
    }

    /// @inheritdoc ICollateralManager
    function getPriceFeedDecimals(address token) external view override returns (uint8) {
        _requireIsCollateral(token);
        return IPriceFeed(_collateralConfigMap[token].priceFeed).decimals();
    }

    /// @inheritdoc ICollateralManager
    function getPrice(address token, uint256 interval) external view override returns (uint256) {
        _requireIsCollateral(token);
        return IPriceFeed(_collateralConfigMap[token].priceFeed).getPrice(interval);
    }

    function getMaxCollateralTokensPerAccount() external view override returns (uint8) {
        return _maxCollateralTokensPerAccount;
    }

    /// @inheritdoc ICollateralManager
    function getMmRatioBuffer() external view override returns (uint24) {
        return _mmRatioBuffer;
    }

    /// @inheritdoc ICollateralManager
    function getDebtNonSettlementTokenValueRatio() external view override returns (uint24) {
        return _debtNonSettlementTokenValueRatio;
    }

    /// @inheritdoc ICollateralManager
    function getLiquidationRatio() external view override returns (uint24) {
        return _liquidationRatio;
    }

    /// @inheritdoc ICollateralManager
    function getCLInsuranceFundFeeRatio() external view override returns (uint24) {
        return _clInsuranceFundFeeRatio;
    }

    /// @inheritdoc ICollateralManager
    function getDebtThreshold() external view override returns (uint256) {
        return _debtThreshold;
    }

    /// @inheritdoc ICollateralManager
    function getDebtThresholdByTrader(address trader) external view override returns (uint256) {
        return _whitelistedDebtThresholdMap[trader] == 0 ? _debtThreshold : _whitelistedDebtThresholdMap[trader];
    }

    /// @inheritdoc ICollateralManager
    function getTotalWhitelistedDebtThreshold() external view override returns (uint256) {
        return _totalWhitelistedDebtThreshold;
    }

    /// @inheritdoc ICollateralManager
    function getCollateralValueDust() external view override returns (uint256) {
        return _collateralValueDust;
    }

    //
    // PUBLIC VIEW
    //

    /// @inheritdoc ICollateralManager
    function isCollateral(address token) public view override returns (bool) {
        return _collateralConfigMap[token].priceFeed != address(0);
    }

    /// @inheritdoc ICollateralManager
    function requireValidCollateralMmRatio(uint24 mmRatioBuffer) public view override returns (uint24) {
        uint24 collateralMmRatio = IClearingHouseConfig(_clearingHouseConfig).getMmRatio() + mmRatioBuffer;
        // CM_ICMR : invalid collateralMmRatio
        require(collateralMmRatio <= _ONE_HUNDRED_PERCENT_RATIO, "CM_ICMR");

        return collateralMmRatio;
    }

    //
    // INTERNAL VIEW
    //

    function _requireIsCollateral(address token) internal view {
        // CM_TINAC: token is not a collateral
        require(isCollateral(token), "CM_TINAC");
    }
}
