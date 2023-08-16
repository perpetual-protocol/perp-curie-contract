pragma solidity 0.7.6;
pragma abicoder v2;

import "forge-std/Test.sol";
import "../../../contracts/MarketRegistry.sol";
import "../../../contracts/ClearingHouse.sol";
import "../../../contracts/OrderBook.sol";
import "../../../contracts/ClearingHouseConfig.sol";
import "../../../contracts/InsuranceFund.sol";
import "../../../contracts/AccountBalance.sol";
import "../../../contracts/Vault.sol";
import "../../../contracts/QuoteToken.sol";
import "../../../contracts/BaseToken.sol";
import "../../../contracts/VirtualToken.sol";
import "../../../contracts/test/TestERC20.sol";
import { IPriceFeed } from "@perp/perp-oracle-contract/contracts/interface/IPriceFeed.sol";
import { IUniswapV3Factory } from "@uniswap/v3-core/contracts/interfaces/IUniswapV3Factory.sol";
import { IUniswapV3PoolDeployer } from "@uniswap/v3-core/contracts/interfaces/IUniswapV3PoolDeployer.sol";
import { IUniswapV3Pool } from "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import { ERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import "./DeployConfig.sol";
import "../interface/ITestExchange.sol";

contract Setup is Test, DeployConfig {
    address internal _BASE_TOKEN_PRICE_FEED = makeAddr("_BASE_TOKEN_PRICE_FEED");
    address internal _BASE_TOKEN_2_PRICE_FEED = makeAddr("_BASE_TOKEN_2_PRICE_FEED");
    MarketRegistry public marketRegistry;
    ClearingHouse public clearingHouse;
    ClearingHouseConfig public clearingHouseConfig;
    InsuranceFund public insuranceFund;
    AccountBalance public accountBalance;
    OrderBook public orderBook;
    ITestExchange public exchange;
    Vault public vault;
    IUniswapV3Factory public uniswapV3Factory;
    IUniswapV3Pool public pool;
    IUniswapV3Pool public pool2;
    BaseToken public baseToken;
    BaseToken public baseToken2;
    QuoteToken public quoteToken;
    TestERC20 public usdc;

    function setUp() public virtual {
        // External
        uniswapV3Factory = _create_UniswapV3Factory();
        usdc = _create_TestERC20("USD Coin", "USDC", 6);

        // Cores
        clearingHouseConfig = _create_ClearingHouseConfig();
        quoteToken = _create_QuoteToken();
        marketRegistry = _create_MarketRegistry(address(uniswapV3Factory), address(quoteToken));
        insuranceFund = _create_InsuranceFund(address(usdc));
        orderBook = _create_OrderBook(address(marketRegistry));
        exchange = _create_Exchange(address(marketRegistry), address(orderBook), address(clearingHouseConfig));
        accountBalance = _create_AccountBalance(address(clearingHouseConfig), address(orderBook));
        vault = _create_Vault(
            address(insuranceFund),
            address(clearingHouseConfig),
            address(accountBalance),
            address(exchange)
        );
        clearingHouse = _create_ClearingHouse(
            address(clearingHouseConfig),
            address(vault),
            address(quoteToken),
            address(uniswapV3Factory),
            address(exchange),
            address(accountBalance),
            address(insuranceFund)
        );
        baseToken = _create_BaseToken(_BASE_TOKEN_NAME, address(quoteToken), _BASE_TOKEN_PRICE_FEED, false);
        baseToken2 = _create_BaseToken(_BASE_TOKEN_2_NAME, address(quoteToken), _BASE_TOKEN_2_PRICE_FEED, false);
        pool = _create_UniswapV3Pool(uniswapV3Factory, baseToken, quoteToken, _DEFAULT_POOL_FEE);
        pool2 = _create_UniswapV3Pool(uniswapV3Factory, baseToken2, quoteToken, _DEFAULT_POOL_FEE);

        _setter();

        // Label addresses for easier debugging
        vm.label(address(clearingHouseConfig), "ClearingHouseConfig");
        vm.label(address(marketRegistry), "MarketRegistry");
        vm.label(address(insuranceFund), "InsuranceFund");
        vm.label(address(orderBook), "OrderBook");
        vm.label(address(exchange), "Exchange");
        vm.label(address(accountBalance), "AccountBalance");
        vm.label(address(vault), "Vault");
        vm.label(address(clearingHouse), "ClearingHouse");
        vm.label(address(baseToken), "BaseToken");
        vm.label(address(baseToken2), "BaseToken2");
        vm.label(address(quoteToken), "QuoteToken");
        vm.label(address(pool), "Pool");
        vm.label(address(pool2), "Pool2");
        vm.label(address(usdc), "Usdc");
    }

    function _create_QuoteToken() internal returns (QuoteToken) {
        QuoteToken newQuoteToken = new QuoteToken();
        newQuoteToken.initialize(_QUOTE_TOKEN_NAME, _QUOTE_TOKEN_NAME);
        return newQuoteToken;
    }

    function _create_BaseToken(
        string memory tokenName,
        address quoteTokenArg,
        address baseTokenPriceFeed,
        bool largerThan
    ) internal returns (BaseToken) {
        BaseToken newBaseToken;
        while (address(newBaseToken) == address(0) || (largerThan != (quoteTokenArg < address(newBaseToken)))) {
            newBaseToken = new BaseToken();
        }
        // NOTE: put faked code on price feed address, must have contract code to make mockCall
        vm.etch(baseTokenPriceFeed, "_PRICE_FEED");
        vm.mockCall(baseTokenPriceFeed, abi.encodeWithSelector(IPriceFeed.decimals.selector), abi.encode(18));
        newBaseToken.initialize(tokenName, tokenName, baseTokenPriceFeed);
        return newBaseToken;
    }

    function _create_UniswapV3Factory() internal returns (IUniswapV3Factory) {
        bytes memory bytecode = abi.encodePacked(vm.getCode("UniswapV3Factory.sol:UniswapV3Factory"));
        address anotherAddress;
        assembly {
            anotherAddress := create(0, add(bytecode, 0x20), mload(bytecode))
        }
        return IUniswapV3Factory(anotherAddress);
    }

    function _create_UniswapV3Pool(
        IUniswapV3Factory uniswapV3FactoryArg,
        BaseToken baseTokenArg,
        QuoteToken quoteTokenArg,
        uint24 fee
    ) internal returns (IUniswapV3Pool) {
        address poolAddress = uniswapV3FactoryArg.createPool(address(baseTokenArg), address(quoteTokenArg), fee);
        baseTokenArg.addWhitelist(poolAddress);
        quoteTokenArg.addWhitelist(poolAddress);
        return IUniswapV3Pool(poolAddress);
    }

    function _create_MarketRegistry(address uniswapV3FactoryArg, address quoteTokenArg)
        internal
        returns (MarketRegistry)
    {
        MarketRegistry newMarketRegistry = new MarketRegistry();
        newMarketRegistry.initialize(uniswapV3FactoryArg, quoteTokenArg);
        newMarketRegistry.setFeeManager(address(this), true);
        return newMarketRegistry;
    }

    function _create_Exchange(
        address marketRegistryArg,
        address orderBookArg,
        address clearingHouseConfigArg
    ) internal returns (ITestExchange) {
        bytes memory bytecode = abi.encodePacked(vm.getCode("Exchange.sol:Exchange"));
        address exchangeAddress;
        assembly {
            exchangeAddress := create(0, add(bytecode, 0x20), mload(bytecode))
        }
        ITestExchange(exchangeAddress).initialize(marketRegistryArg, orderBookArg, clearingHouseConfigArg);
        return ITestExchange(exchangeAddress);
    }

    function _create_OrderBook(address marketRegistryArg) internal returns (OrderBook) {
        OrderBook newOrderBook = new OrderBook();
        newOrderBook.initialize(marketRegistryArg);
        return newOrderBook;
    }

    function _create_ClearingHouseConfig() internal returns (ClearingHouseConfig) {
        ClearingHouseConfig newClearingHouseConfig = new ClearingHouseConfig();
        newClearingHouseConfig.initialize();
        return newClearingHouseConfig;
    }

    function _create_ClearingHouse(
        address clearingHouseConfigArg,
        address vaultArg,
        address quoteTokenArg,
        address uniswapV3FactoryArg,
        address exchangeArg,
        address accountBalanceArg,
        address insuranceFundArg
    ) internal returns (ClearingHouse) {
        ClearingHouse newClearingHouse = new ClearingHouse();
        newClearingHouse.initialize(
            clearingHouseConfigArg,
            vaultArg,
            quoteTokenArg,
            uniswapV3FactoryArg,
            exchangeArg,
            accountBalanceArg,
            insuranceFundArg
        );
        return newClearingHouse;
    }

    function _create_InsuranceFund(address usdcArg) internal returns (InsuranceFund) {
        InsuranceFund newInsuranceFund = new InsuranceFund();
        newInsuranceFund.initialize(usdcArg);

        return newInsuranceFund;
    }

    function _create_AccountBalance(address clearingHouseConfigArg, address orderBookArg)
        internal
        returns (AccountBalance)
    {
        AccountBalance newAccountBalance = new AccountBalance();
        newAccountBalance.initialize(clearingHouseConfigArg, orderBookArg);
        return newAccountBalance;
    }

    function _create_Vault(
        address insuranceFundArg,
        address clearingHouseConfigArg,
        address accountBalanceArg,
        address exchangeArg
    ) internal returns (Vault) {
        Vault newVault = new Vault();
        newVault.initialize(insuranceFundArg, clearingHouseConfigArg, accountBalanceArg, exchangeArg);
        return newVault;
    }

    function _create_TestERC20(
        string memory name,
        string memory symbol,
        uint8 decimal
    ) internal returns (TestERC20) {
        TestERC20 testErc20 = new TestERC20();
        testErc20.__TestERC20_init(name, symbol, decimal);
        return testErc20;
    }

    function _setter() internal {
        // baseToken
        baseToken.mintMaximumTo(address(clearingHouse));
        baseToken.addWhitelist(address(clearingHouse));
        baseToken.addWhitelist(address(pool));

        // baseToken2
        baseToken2.mintMaximumTo(address(clearingHouse));
        baseToken2.addWhitelist(address(clearingHouse));
        baseToken2.addWhitelist(address(pool2));

        // quoteToken
        quoteToken.mintMaximumTo(address(clearingHouse));
        quoteToken.addWhitelist(address(clearingHouse));
        quoteToken.addWhitelist(address(pool));
        quoteToken.addWhitelist(address(pool2));

        // clearingHouseConfig
        clearingHouseConfig.setMaxMarketsPerAccount(MAX_MARKETS_PER_ACCOUNT);
        uint8 settlementTokenDecimals = vault.decimals();
        clearingHouseConfig.setSettlementTokenBalanceCap(SETTLEMENT_TOKEN_BALANCE_CAP * 10**settlementTokenDecimals);

        // marketRegistry
        marketRegistry.setClearingHouse(address(clearingHouse));
        marketRegistry.setMaxOrdersPerMarket(MAX_ORDERS_PER_MARKET);

        // insuranceFund
        insuranceFund.setVault(address(vault));

        // orderBook
        orderBook.setClearingHouse(address(clearingHouse));
        orderBook.setExchange(address(exchange));

        // exchange
        exchange.setClearingHouse(address(clearingHouse));
        exchange.setAccountBalance(address(accountBalance));

        // accountBalance
        accountBalance.setClearingHouse(address(clearingHouse));
        accountBalance.setVault(address(vault));

        // vault
        vault.setClearingHouse(address(clearingHouse));
    }
}
