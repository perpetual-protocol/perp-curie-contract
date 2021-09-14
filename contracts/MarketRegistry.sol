// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;
pragma abicoder v2;

import { AddressUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/AddressUpgradeable.sol";
import { IERC20Metadata } from "./interface/IERC20Metadata.sol";
import { SafeOwnable } from "./base/SafeOwnable.sol";
import { UniswapV3Broker } from "./lib/UniswapV3Broker.sol";
import { VirtualToken } from "./VirtualToken.sol";

contract MarketRegistry is SafeOwnable {
    using AddressUpgradeable for address;

    //
    // STRUCT
    //
    struct MarketInfo {
        address pool;
        uint24 exchangeFeeRatio;
        uint24 uniswapFeeRatio;
        uint24 insuranceFundFeeRatio;
    }

    //
    // STATE
    //
    address public uniswapV3Factory;
    address public quoteToken;
    address public clearingHouse;
    uint8 public maxOrdersPerMarket;

    // key: baseToken, value: pool
    mapping(address => address) internal _poolMap;

    // key: baseToken, what insurance fund get = exchangeFee * insuranceFundFeeRatio
    mapping(address => uint24) internal _insuranceFundFeeRatioMap;

    // key: baseToken , uniswap fee will be ignored and use the exchangeFeeRatio instead
    mapping(address => uint24) internal _exchangeFeeRatioMap;

    // key: baseToken, _uniswapFeeRatioMap cache only
    mapping(address => uint24) internal _uniswapFeeRatioMap;

    //
    // EVENT
    //
    event PoolAdded(address indexed baseToken, uint24 indexed feeRatio, address indexed pool);
    event ClearingHouseChanged(address indexed clearingHouse);
    event FeeRatioChanged(address baseToken, uint24 feeRatio);
    event InsuranceFundFeeRatioChanged(uint24 feeRatio);
    event MaxOrdersPerMarketChanged(uint24 feeRatio);

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
        uniswapV3Factory = uniswapV3FactoryArg;
        quoteToken = quoteTokenArg;
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

    function addPool(address baseToken, uint24 feeRatio) external onlyOwner returns (address) {
        // baseToken decimals is not 18
        require(IERC20Metadata(baseToken).decimals() == 18, "MR_BDN18");
        // clearingHouse base token balance not enough
        require(IERC20Metadata(baseToken).balanceOf(clearingHouse) == type(uint256).max, "MR_CHBNE");

        // quote token total supply not enough
        require(IERC20Metadata(quoteToken).totalSupply() == type(uint256).max, "MR_QTSNE");

        // to ensure the base is always token0 and quote is always token1
        // invalid baseToken
        require(baseToken < quoteToken, "MR_IB");

        address pool = UniswapV3Broker.getPool(uniswapV3Factory, quoteToken, baseToken, feeRatio);
        // non-existent pool in uniswapV3 factory
        require(pool != address(0), "MR_NEP");
        // existent pool
        require(_poolMap[baseToken] == address(0), "MR_EP");
        // pool not (yet) initialized
        require(UniswapV3Broker.getSqrtMarkPriceX96(pool) != 0, "MR_PNI");

        // clearingHouse not in baseToken whitelist
        require(VirtualToken(baseToken).isInWhitelist(clearingHouse), "MR_CNBWL");
        // pool not in baseToken whitelist
        require(VirtualToken(baseToken).isInWhitelist(pool), "MR_PNBWL");

        // clearingHouse not in quoteToken whitelist
        require(VirtualToken(quoteToken).isInWhitelist(clearingHouse), "MR_CHNQWL");
        // pool not in quoteToken whitelist
        require(VirtualToken(quoteToken).isInWhitelist(pool), "MR_PNQWL");

        _poolMap[baseToken] = pool;
        _uniswapFeeRatioMap[baseToken] = feeRatio;
        _exchangeFeeRatioMap[baseToken] = feeRatio;

        emit PoolAdded(baseToken, feeRatio, pool);
        return pool;
    }

    function setClearingHouse(address clearingHouseArg) external onlyOwner {
        // ClearingHouse is not contract
        require(clearingHouseArg.isContract(), "MR_CHNC");
        clearingHouse = clearingHouseArg;
        emit ClearingHouseChanged(clearingHouseArg);
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
        emit InsuranceFundFeeRatioChanged(insuranceFundFeeRatioArg);
    }

    function setMaxOrdersPerMarket(uint8 maxOrdersPerMarketArg) external onlyOwner {
        maxOrdersPerMarket = maxOrdersPerMarketArg;
        emit MaxOrdersPerMarketChanged(maxOrdersPerMarketArg);
    }

    //
    // EXTERNAL VIEW
    //
    function getPool(address baseToken) external view returns (address) {
        return _poolMap[baseToken];
    }

    function getFeeRatio(address baseToken) external view returns (uint24) {
        return _exchangeFeeRatioMap[baseToken];
    }

    function getInsuranceFundFeeRatio(address baseToken) external view returns (uint24) {
        return _insuranceFundFeeRatioMap[baseToken];
    }

    function getMarketInfo(address baseToken) external view returns (MarketInfo memory) {
        return
            MarketInfo({
                pool: _poolMap[baseToken],
                exchangeFeeRatio: _exchangeFeeRatioMap[baseToken],
                uniswapFeeRatio: _uniswapFeeRatioMap[baseToken],
                insuranceFundFeeRatio: _insuranceFundFeeRatioMap[baseToken]
            });
    }
}
