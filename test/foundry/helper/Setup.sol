pragma solidity 0.7.6;
pragma abicoder v2;

import "forge-std/Test.sol";
import "../../../contracts/MarketRegistry.sol";
import "../../../contracts/ClearingHouse.sol";
import "../../../contracts/ClearingHouseConfig.sol";
import "../../../contracts/AccountBalance.sol";
import "../../../contracts/OrderBook.sol";
import "../../../contracts/QuoteToken.sol";
import "../../../contracts/BaseToken.sol";
import "../../../contracts/VirtualToken.sol";
import { IPriceFeed } from "@perp/perp-oracle-contract/contracts/interface/IPriceFeed.sol";
import { UniswapV3Factory } from "@uniswap/v3-core/contracts/UniswapV3Factory.sol";
import { UniswapV3Pool } from "@uniswap/v3-core/contracts/UniswapV3Pool.sol";
import { ERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";

contract Setup is Test {
    string internal constant _BASE_TOKEN_NAME = "vETH";
    string internal constant _QUOTE_TOKEN_NAME = "vUSD";
    uint24 internal constant _DEFAULT_POOL_FEE = 3000;
    address internal _PRICE_FEED = makeAddr("_PRICE_FEED");
    MarketRegistry public marketRegistry;
    ClearingHouse public clearingHouse;
    UniswapV3Factory public uniswapV3Factory;
    UniswapV3Pool public pool;
    BaseToken public baseToken;
    QuoteToken public quoteToken;
    OrderBook public orderBook;
    ClearingHouseConfig public clearingHouseConfig;
    AccountBalance public accountBalance;

    function setUp() public virtual {
        uniswapV3Factory = _create_UniswapV3Factory();
        quoteToken = _create_QuoteToken();
        clearingHouse = _create_ClearingHouse();
        marketRegistry = _create_MarketRegistry(address(uniswapV3Factory), address(quoteToken), address(clearingHouse));
        baseToken = _create_BaseToken(_BASE_TOKEN_NAME, address(quoteToken), address(clearingHouse), false);
        pool = _create_UniswapV3Pool(uniswapV3Factory, baseToken, quoteToken, _DEFAULT_POOL_FEE);
        clearingHouseConfig = _create_ClearingHouseConfig();
        orderBook = _create_OrderBook(address(marketRegistry));
        accountBalance = _create_AccountBalance(
            address(clearingHouseConfig),
            address(orderBook),
            address(clearingHouse)
        );
    }

    function _create_QuoteToken() internal returns (QuoteToken) {
        QuoteToken quoteToken = new QuoteToken();
        quoteToken.initialize(_QUOTE_TOKEN_NAME, _QUOTE_TOKEN_NAME);
        vm.mockCall(address(quoteToken), abi.encodeWithSelector(ERC20Upgradeable.decimals.selector), abi.encode(18));
        vm.mockCall(
            address(quoteToken),
            abi.encodeWithSelector(ERC20Upgradeable.totalSupply.selector),
            abi.encode(type(uint256).max)
        );
        vm.mockCall(address(quoteToken), abi.encodeWithSelector(VirtualToken.isInWhitelist.selector), abi.encode(true));
        return quoteToken;
    }

    function _create_BaseToken(
        string memory tokenName,
        address quoteToken,
        address clearingHouse,
        bool largerThan
    ) internal returns (BaseToken) {
        BaseToken baseToken;
        while (address(baseToken) == address(0) || (largerThan != (quoteToken < address(baseToken)))) {
            baseToken = new BaseToken();
        }
        // NOTE: put faked code on price feed address, must have contract code to make mockCall
        vm.etch(_PRICE_FEED, "_PRICE_FEED");
        vm.mockCall(_PRICE_FEED, abi.encodeWithSelector(IPriceFeed.decimals.selector), abi.encode(18));
        baseToken.initialize(tokenName, tokenName, _PRICE_FEED);
        baseToken.mintMaximumTo(clearingHouse);
        baseToken.addWhitelist(clearingHouse);
        return baseToken;
    }

    function _create_UniswapV3Factory() internal returns (UniswapV3Factory) {
        return new UniswapV3Factory();
    }

    function _create_UniswapV3Pool(
        UniswapV3Factory uniswapV3Factory,
        BaseToken baseToken,
        QuoteToken quoteToken,
        uint24 fee
    ) internal returns (UniswapV3Pool) {
        address poolAddress = uniswapV3Factory.createPool(address(baseToken), address(quoteToken), fee);
        baseToken.addWhitelist(poolAddress);
        quoteToken.addWhitelist(poolAddress);
        return UniswapV3Pool(poolAddress);
    }

    function _create_MarketRegistry(
        address uniswapV3Factory,
        address quoteToken,
        address clearingHouse
    ) internal returns (MarketRegistry) {
        MarketRegistry marketRegistry = new MarketRegistry();
        marketRegistry.initialize(uniswapV3Factory, quoteToken);
        marketRegistry.setClearingHouse(clearingHouse);
        return marketRegistry;
    }

    function _create_ClearingHouse() internal returns (ClearingHouse) {
        return new ClearingHouse();
    }

    function _create_ClearingHouseConfig() internal returns (ClearingHouseConfig) {
        ClearingHouseConfig clearingHouseConfig = new ClearingHouseConfig();
        clearingHouseConfig.initialize();
        return clearingHouseConfig;
    }

    function _create_OrderBook(address marketRegistry) internal returns (OrderBook) {
        OrderBook orderBook = new OrderBook();
        orderBook.initialize(marketRegistry);
        return orderBook;
    }

    function _create_AccountBalance(
        address clearingHouseConfig,
        address orderBook,
        address clearingHouse
    ) internal returns (AccountBalance) {
        AccountBalance accountBalance = new AccountBalance();
        accountBalance.initialize(clearingHouseConfig, orderBook);
        accountBalance.setClearingHouse(clearingHouse);
        return accountBalance;
    }
}
