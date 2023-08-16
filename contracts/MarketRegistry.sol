// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.7.6;
pragma abicoder v2;

import { AddressUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/AddressUpgradeable.sol";
import { IERC20Metadata } from "./interface/IERC20Metadata.sol";
import { ClearingHouseCallee } from "./base/ClearingHouseCallee.sol";
import { UniswapV3Broker } from "./lib/UniswapV3Broker.sol";
import { PerpMath } from "./lib/PerpMath.sol";
import { PerpSafeCast } from "./lib/PerpSafeCast.sol";
import { IVirtualToken } from "./interface/IVirtualToken.sol";
import { MarketRegistryStorageV4 } from "./storage/MarketRegistryStorage.sol";
import { IMarketRegistry } from "./interface/IMarketRegistry.sol";
import { IMarketRegistryFeeManager } from "./interface/IMarketRegistryFeeManager.sol";

// never inherit any new stateful contract. never change the orders of parent stateful contracts
contract MarketRegistry is IMarketRegistry, IMarketRegistryFeeManager, ClearingHouseCallee, MarketRegistryStorageV4 {
    using AddressUpgradeable for address;
    using PerpSafeCast for uint256;
    using PerpMath for uint24;
    using PerpMath for uint256;

    //
    // CONSTANT
    //
    uint24 internal constant _DEFAULT_MAX_MARKET_PRICE_SPREAD_RATIO = 0.1e6; // 10% in decimal 6
    uint24 private constant _ONE_HUNDRED_PERCENT_RATIO = 1e6;

    //
    // MODIFIER
    //

    modifier checkRatio(uint24 ratio) {
        // ratio overflow
        require(ratio <= 1e6, "MR_RO");
        _;
    }

    modifier checkPool(address baseToken) {
        // pool not exists
        require(_poolMap[baseToken] != address(0), "MR_PNE");
        _;
    }

    modifier onlyFeeManager() {
        // MR_OFM: only fee manager
        require(_feeManagerMap[msg.sender], "MR_OFM");
        _;
    }

    //
    // EXTERNAL NON-VIEW
    //

    function initialize(address uniswapV3FactoryArg, address quoteTokenArg) external initializer {
        __ClearingHouseCallee_init();

        // UnsiwapV3Factory is not contract
        require(uniswapV3FactoryArg.isContract(), "MR_UFNC");
        // QuoteToken is not contract
        require(quoteTokenArg.isContract(), "MR_QTNC");

        // update states
        _uniswapV3Factory = uniswapV3FactoryArg;
        _quoteToken = quoteTokenArg;
        _maxOrdersPerMarket = type(uint8).max;
    }

    function addPool(address baseToken, uint24 feeRatio) external onlyOwner returns (address) {
        // existent pool
        require(_poolMap[baseToken] == address(0), "MR_EP");
        // baseToken decimals is not 18
        require(IERC20Metadata(baseToken).decimals() == 18, "MR_BDN18");
        // clearingHouse base token balance not enough
        require(IERC20Metadata(baseToken).balanceOf(_clearingHouse) == type(uint256).max, "MR_CHBNE");

        // quote token total supply not enough
        require(IERC20Metadata(_quoteToken).totalSupply() == type(uint256).max, "MR_QTSNE");

        // to ensure the base is always token0 and quote is always token1
        // invalid baseToken
        require(baseToken < _quoteToken, "MR_IB");

        address pool = UniswapV3Broker.getPool(_uniswapV3Factory, _quoteToken, baseToken, feeRatio);
        // non-existent pool in uniswapV3 factory
        require(pool != address(0), "MR_NEP");

        (uint256 sqrtPriceX96, , , , , , ) = UniswapV3Broker.getSlot0(pool);
        // pool not (yet) initialized
        require(sqrtPriceX96 != 0, "MR_PNI");

        // clearingHouse not in baseToken whitelist
        require(IVirtualToken(baseToken).isInWhitelist(_clearingHouse), "MR_CNBWL");
        // pool not in baseToken whitelist
        require(IVirtualToken(baseToken).isInWhitelist(pool), "MR_PNBWL");

        // clearingHouse not in quoteToken whitelist
        require(IVirtualToken(_quoteToken).isInWhitelist(_clearingHouse), "MR_CHNQWL");
        // pool not in quoteToken whitelist
        require(IVirtualToken(_quoteToken).isInWhitelist(pool), "MR_PNQWL");

        _poolMap[baseToken] = pool;
        _uniswapFeeRatioMap[baseToken] = feeRatio;
        _exchangeFeeRatioMap[baseToken] = feeRatio;

        emit PoolAdded(baseToken, feeRatio, pool);
        return pool;
    }

    function setFeeRatio(address baseToken, uint24 feeRatio)
        external
        checkPool(baseToken)
        checkRatio(feeRatio)
        onlyOwner
    {
        _exchangeFeeRatioMap[baseToken] = feeRatio;
        emit FeeRatioChanged(baseToken, feeRatio);
    }

    function setInsuranceFundFeeRatio(address baseToken, uint24 insuranceFundFeeRatioArg)
        external
        checkPool(baseToken)
        checkRatio(insuranceFundFeeRatioArg)
        onlyOwner
    {
        _insuranceFundFeeRatioMap[baseToken] = insuranceFundFeeRatioArg;
        emit InsuranceFundFeeRatioChanged(baseToken, insuranceFundFeeRatioArg);
    }

    function setMaxOrdersPerMarket(uint8 maxOrdersPerMarketArg) external onlyOwner {
        _maxOrdersPerMarket = maxOrdersPerMarketArg;
        emit MaxOrdersPerMarketChanged(maxOrdersPerMarketArg);
    }

    function setMarketMaxPriceSpreadRatio(address baseToken, uint24 ratio) external onlyOwner {
        _marketMaxPriceSpreadRatioMap[baseToken] = ratio;
        emit MarketMaxPriceSpreadRatioChanged(baseToken, ratio);
    }

    function setFeeDiscountRatio(address trader, uint24 discountRatio)
        external
        override
        checkRatio(discountRatio)
        onlyFeeManager
    {
        _feeDiscountRatioMap[trader] = discountRatio;
        emit FeeDiscountRatioChanged(trader, discountRatio);
    }

    function setFeeManager(address accountArg, bool isFeeManagerArg) external onlyOwner {
        if (_feeManagerMap[accountArg] == isFeeManagerArg) {
            return;
        }
        _feeManagerMap[accountArg] = isFeeManagerArg;
        emit FeeManagerChanged(accountArg, isFeeManagerArg);
    }

    //
    // EXTERNAL VIEW
    //

    /// @inheritdoc IMarketRegistry
    function getQuoteToken() external view override returns (address) {
        return _quoteToken;
    }

    /// @inheritdoc IMarketRegistry
    function getUniswapV3Factory() external view override returns (address) {
        return _uniswapV3Factory;
    }

    /// @inheritdoc IMarketRegistry
    function getMaxOrdersPerMarket() external view override returns (uint8) {
        return _maxOrdersPerMarket;
    }

    /// @inheritdoc IMarketRegistry
    function getPool(address baseToken) external view override checkPool(baseToken) returns (address) {
        return _poolMap[baseToken];
    }

    /// @inheritdoc IMarketRegistry
    function getFeeRatio(address baseToken) external view override checkPool(baseToken) returns (uint24) {
        return _exchangeFeeRatioMap[baseToken];
    }

    /// @inheritdoc IMarketRegistry
    function getInsuranceFundFeeRatio(address baseToken) external view override checkPool(baseToken) returns (uint24) {
        return _insuranceFundFeeRatioMap[baseToken];
    }

    /// @inheritdoc IMarketRegistry
    /// @dev if we didn't set the max spread ratio for the market, we will use the default value
    function getMarketMaxPriceSpreadRatio(address baseToken) external view override returns (uint24) {
        return _getMarketMaxPriceSpreadRatio(baseToken);
    }

    /// @inheritdoc IMarketRegistryFeeManager
    function isFeeManager(address account) external view override returns (bool) {
        return _feeManagerMap[account];
    }

    /// @inheritdoc IMarketRegistry
    function getMarketInfo(address baseToken) external view override checkPool(baseToken) returns (MarketInfo memory) {
        return
            MarketInfo({
                pool: _poolMap[baseToken],
                exchangeFeeRatio: _exchangeFeeRatioMap[baseToken],
                uniswapFeeRatio: _uniswapFeeRatioMap[baseToken],
                insuranceFundFeeRatio: _insuranceFundFeeRatioMap[baseToken],
                maxPriceSpreadRatio: _getMarketMaxPriceSpreadRatio(baseToken)
            });
    }

    function getMarketInfoByTrader(address trader, address baseToken)
        external
        view
        override
        checkPool(baseToken)
        returns (MarketInfo memory)
    {
        uint24 exchangeFeeRatio =
            uint256(_exchangeFeeRatioMap[baseToken])
                .mulRatio(_ONE_HUNDRED_PERCENT_RATIO.subRatio(_feeDiscountRatioMap[trader]))
                .toUint24();

        return
            MarketInfo({
                pool: _poolMap[baseToken],
                exchangeFeeRatio: exchangeFeeRatio,
                uniswapFeeRatio: _uniswapFeeRatioMap[baseToken],
                insuranceFundFeeRatio: _insuranceFundFeeRatioMap[baseToken],
                maxPriceSpreadRatio: _getMarketMaxPriceSpreadRatio(baseToken)
            });
    }

    /// @inheritdoc IMarketRegistry
    function hasPool(address baseToken) external view override returns (bool) {
        return _poolMap[baseToken] != address(0);
    }

    //
    // INTERNAL VIEW
    //

    function _getMarketMaxPriceSpreadRatio(address baseToken) internal view returns (uint24) {
        uint24 maxSpreadRatio =
            _marketMaxPriceSpreadRatioMap[baseToken] > 0
                ? _marketMaxPriceSpreadRatioMap[baseToken]
                : _DEFAULT_MAX_MARKET_PRICE_SPREAD_RATIO;
        return maxSpreadRatio;
    }
}
