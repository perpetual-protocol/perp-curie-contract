// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;
pragma abicoder v2;

import { SafeOwnable } from "./base/SafeOwnable.sol";
import { IERC20Metadata } from "./interface/IERC20Metadata.sol";

// TODO remove
import { UniswapV3Broker } from "./lib/UniswapV3Broker.sol";
import { VirtualToken } from "./VirtualToken.sol";

contract ExchangeRegistry is SafeOwnable {
    // TODO should be immutable, check how to achieve this in oz upgradeable framework.
    address public uniswapV3Factory;
    address public quoteToken;
    address public clearingHouse;

    uint8 public maxOrdersPerMarket;

    // key: base token, value: pool
    mapping(address => address) internal _poolMap;

    // key: pool , uniswap fee will be ignored and use the exchangeFeeRatio instead
    mapping(address => uint24) internal _exchangeFeeRatioMap;

    // key: pool, _uniswapFeeRatioMap cache only
    mapping(address => uint24) internal _uniswapFeeRatioMap;

    // TODO change to pool as key?
    // key: baseToken, what insurance fund get = exchangeFee * insuranceFundFeeRatio
    mapping(address => uint24) internal _insuranceFundFeeRatioMap;

    event PoolAdded(address indexed baseToken, uint24 indexed feeRatio, address indexed pool);

    function initialize(
        address uniswapV3FactoryArg,
        address quoteTokenArg,
        address clearingHouseArg
    ) external initializer {
        __SafeOwnable_init();

        // UnsiwapV3Factory is 0
        require(uniswapV3FactoryArg != address(0), "EX_UF0");
        // QuoteToken is 0
        require(quoteTokenArg != address(0), "EX_QT0");
        // ClearingHouse is 0
        require(clearingHouseArg != address(0), "EX_CH0");

        // update states
        uniswapV3Factory = uniswapV3FactoryArg;
        quoteToken = quoteTokenArg;
        clearingHouse = clearingHouseArg;
    }

    //
    // MODIFIERS
    //

    modifier checkRatio(uint24 ratio) {
        // EX_RO: ratio overflow
        require(ratio <= 1e6, "EX_RO");
        _;
    }

    //
    // EXTERNAL ADMIN FUNCTIONS
    //

    // TODO add onlyOwner
    function addPool(address baseToken, uint24 feeRatio) external returns (address) {
        // EX_BDN18: baseToken decimals is not 18
        require(IERC20Metadata(baseToken).decimals() == 18, "EX_BDN18");
        // EX_CHBNE: clearingHouse base token balance not enough, should be maximum of uint256
        require(IERC20Metadata(baseToken).balanceOf(clearingHouse) == type(uint256).max, "EX_CHBNE");

        // TODO remove this once quotToken's balance is checked in CH's initializer
        // EX_QTSNE: quote token total supply not enough, should be maximum of uint256
        require(IERC20Metadata(quoteToken).totalSupply() == type(uint256).max, "EX_QTSNE");

        // to ensure the base is always token0 and quote is always token1
        // EX_IB: invalid baseToken
        require(baseToken < quoteToken, "EX_IB");

        address pool = UniswapV3Broker.getPool(uniswapV3Factory, quoteToken, baseToken, feeRatio);
        // EX_NEP: non-existent pool in uniswapV3 factory
        require(pool != address(0), "EX_NEP");
        // EX_EP: existent pool in ClearingHouse
        require(_poolMap[baseToken] == address(0), "EX_EP");
        // EX_PNI: pool not (yet) initialized
        require(UniswapV3Broker.getSqrtMarkPriceX96(pool) != 0, "EX_PNI");

        // EX_CHNBWL: clearingHouse not in baseToken whitelist
        require(VirtualToken(baseToken).isInWhitelist(clearingHouse), "EX_CHNBWL");
        // EX_PNBWL: pool not in baseToken whitelist
        require(VirtualToken(baseToken).isInWhitelist(pool), "EX_PNBWL");

        // TODO: remove this once quotToken white list is checked in CH or Exchange's initializer
        // EX_CHNQWL: clearingHouse not in quoteToken whitelist
        require(VirtualToken(quoteToken).isInWhitelist(clearingHouse), "EX_CHNQWL");
        // EX_PNQWL: pool not in quoteToken whitelist
        require(VirtualToken(quoteToken).isInWhitelist(pool), "EX_PNQWL");

        _poolMap[baseToken] = pool;
        _uniswapFeeRatioMap[pool] = feeRatio;
        _exchangeFeeRatioMap[pool] = feeRatio;

        emit PoolAdded(baseToken, feeRatio, pool);
        return pool;
    }

    // TODO add onlyOwner
    function setFeeRatio(address baseToken, uint24 feeRatio) external checkRatio(feeRatio) {
        // EX_PNE: pool not exists
        require(_poolMap[baseToken] != address(0), "EX_PNE");
        _exchangeFeeRatioMap[_poolMap[baseToken]] = feeRatio;
    }

    // TODO add onlyOwner
    function setInsuranceFundFeeRatio(address baseToken, uint24 insuranceFundFeeRatioArg)
        external
        checkRatio(insuranceFundFeeRatioArg)
    {
        _insuranceFundFeeRatioMap[baseToken] = insuranceFundFeeRatioArg;
    }

    function setMaxOrdersPerMarket(uint8 maxOrdersPerMarketArg) external {
        maxOrdersPerMarket = maxOrdersPerMarketArg;
    }

    //
    // EXTERNAL VIEW
    //
    function getPool(address baseToken) external view returns (address) {
        return _poolMap[baseToken];
    }

    function getFeeRatio(address baseToken) external view returns (uint24) {
        return _exchangeFeeRatioMap[_poolMap[baseToken]];
    }

    struct Info {
        address pool;
        uint24 exchangeFeeRatio;
        uint24 uniswapFeeRatio;
        uint24 insuranceFundFeeRatio;
    }

    function getInfo(address baseToken) external view returns (Info memory) {
        address pool = _poolMap[baseToken];
        return
            Info({
                pool: pool,
                exchangeFeeRatio: _exchangeFeeRatioMap[pool],
                uniswapFeeRatio: _uniswapFeeRatioMap[pool],
                insuranceFundFeeRatio: _insuranceFundFeeRatioMap[baseToken]
            });
    }
}
