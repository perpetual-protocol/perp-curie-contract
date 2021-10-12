// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;
pragma abicoder v2;

import { AddressUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/AddressUpgradeable.sol";
import { IERC20Metadata } from "./interface/IERC20Metadata.sol";
import { SafeOwnable } from "./base/SafeOwnable.sol";
import { UniswapV3Broker } from "./lib/UniswapV3Broker.sol";
import { IVirtualToken } from "./interface/IVirtualToken.sol";
import { MarketRegistryStorageV1 } from "./storage/MarketRegistryStorage.sol";
import { IMarketRegistry } from "./interface/IMarketRegistry.sol";

// never inherit any new stateful contract. never change the orders of parent stateful contracts
contract MarketRegistry is IMarketRegistry, SafeOwnable, MarketRegistryStorageV1 {
    using AddressUpgradeable for address;

    //
    // CONSTRUCTOR
    //
    function initialize(address uniswapV3FactoryArg, address quoteTokenArg) external initializer {
        __SafeOwnable_init();

        // UnsiwapV3Factory is not contract
        require(uniswapV3FactoryArg.isContract(), "MR_UFNC");
        // QuoteToken is not contract
        require(quoteTokenArg.isContract(), "MR_QTNC");

        // update states
        _uniswapV3Factory = uniswapV3FactoryArg;
        _quoteToken = quoteTokenArg;
    }

    //
    // MODIFIERS
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

    //
    // EXTERNAL ADMIN FUNCTIONS
    //

    function addPool(address baseToken, uint24 feeRatio) external override onlyOwner returns (address) {
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
        // existent pool
        require(_poolMap[baseToken] == address(0), "MR_EP");
        // pool not (yet) initialized
        require(UniswapV3Broker.getSqrtMarkPriceX96(pool) != 0, "MR_PNI");

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

    function setClearingHouse(address clearingHouseArg) external override onlyOwner {
        // ClearingHouse is not contract
        require(clearingHouseArg.isContract(), "MR_CHNC");
        _clearingHouse = clearingHouseArg;
        emit ClearingHouseChanged(clearingHouseArg);
    }

    function setFeeRatio(address baseToken, uint24 feeRatio)
        external
        override
        checkPool(baseToken)
        checkRatio(feeRatio)
        onlyOwner
    {
        _exchangeFeeRatioMap[baseToken] = feeRatio;
        emit FeeRatioChanged(baseToken, feeRatio);
    }

    function setInsuranceFundFeeRatio(address baseToken, uint24 insuranceFundFeeRatioArg)
        external
        override
        checkPool(baseToken)
        checkRatio(insuranceFundFeeRatioArg)
        onlyOwner
    {
        _insuranceFundFeeRatioMap[baseToken] = insuranceFundFeeRatioArg;
        emit InsuranceFundFeeRatioChanged(insuranceFundFeeRatioArg);
    }

    function setMaxOrdersPerMarket(uint8 maxOrdersPerMarketArg) external override onlyOwner {
        _maxOrdersPerMarket = maxOrdersPerMarketArg;
        emit MaxOrdersPerMarketChanged(maxOrdersPerMarketArg);
    }

    //
    // EXTERNAL VIEW
    //

    function getClearingHouse() external view override returns (address) {
        return _clearingHouse;
    }

    function getQuoteToken() external view override returns (address) {
        return _quoteToken;
    }

    function getUniswapV3Factory() external view override returns (address) {
        return _uniswapV3Factory;
    }

    function getMaxOrdersPerMarket() external view override returns (uint8) {
        return _maxOrdersPerMarket;
    }

    function getPool(address baseToken) external view override returns (address) {
        return _poolMap[baseToken];
    }

    function getFeeRatio(address baseToken) external view override returns (uint24) {
        return _exchangeFeeRatioMap[baseToken];
    }

    function getInsuranceFundFeeRatio(address baseToken) external view override returns (uint24) {
        return _insuranceFundFeeRatioMap[baseToken];
    }

    function getMarketInfo(address baseToken) external view override returns (MarketInfo memory) {
        return
            MarketInfo({
                pool: _poolMap[baseToken],
                exchangeFeeRatio: _exchangeFeeRatioMap[baseToken],
                uniswapFeeRatio: _uniswapFeeRatioMap[baseToken],
                insuranceFundFeeRatio: _insuranceFundFeeRatioMap[baseToken]
            });
    }
}
