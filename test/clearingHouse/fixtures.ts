import { MockContract, smockit } from "@eth-optimism/smock"
import { parseEther, parseUnits } from "ethers/lib/utils"
import {
    AccountBalance,
    BaseToken,
    ClearingHouse,
    ClearingHouseConfig,
    CollateralManager,
    DelegateApproval,
    Exchange,
    InsuranceFund,
    MarketRegistry,
    OrderBook,
    TestClearingHouse,
    TestERC20,
    TestExchange,
    TestLimitOrderBook,
    TestUniswapV3Broker,
    UniswapV3Factory,
    UniswapV3Pool,
    Vault,
} from "../../typechain"
import { createQuoteTokenFixture, token0Fixture, tokensFixture, uniswapV3FactoryFixture } from "../shared/fixtures"

import { ethers, waffle } from "hardhat"
import { QuoteToken } from "../../typechain/QuoteToken"
import { TestAccountBalance } from "../../typechain/TestAccountBalance"
import { ChainlinkPriceFeedV2, ChainlinkPriceFeedV3, PriceFeedDispatcher } from "../../typechain/perp-oracle"
import {
    CACHED_TWAP_INTERVAL,
    CHAINLINK_AGGREGATOR_DECIMALS,
    PRICEFEED_DISPATCHER_DECIMALS,
    USDC_DECIMALS,
    WBTC_DECIMALS,
    WETH_DECIMALS,
} from "../shared/constant"

export interface ClearingHouseFixture {
    clearingHouse: TestClearingHouse | ClearingHouse
    orderBook: OrderBook
    accountBalance: TestAccountBalance | AccountBalance
    marketRegistry: MarketRegistry
    clearingHouseConfig: ClearingHouseConfig
    exchange: TestExchange | Exchange
    vault: Vault
    insuranceFund: InsuranceFund
    collateralManager: CollateralManager
    uniV3Factory: UniswapV3Factory
    pool: UniswapV3Pool
    uniFeeTier: number
    USDC: TestERC20
    WETH: TestERC20
    WBTC: TestERC20
    mockedWethPriceFeed: MockContract
    mockedWbtcPriceFeed: MockContract
    mockedPriceFeedDispatcher: MockContract
    mockedPriceFeedDispatcher2: MockContract
    mockedWethPriceFeedDispatcher: MockContract
    mockedWbtcPriceFeedDispatcher: MockContract
    quoteToken: QuoteToken
    baseToken: BaseToken
    baseToken2: BaseToken
    pool2: UniswapV3Pool
}

export interface ClearingHouseWithDelegateApprovalFixture extends ClearingHouseFixture {
    delegateApproval: DelegateApproval
    clearingHouseOpenPositionAction: number
    clearingHouseAddLiquidityAction: number
    clearingHouseRemoveLiquidityAction: number
    notExistedAction: number
    notExistedAction2: number
    limitOrderBook: TestLimitOrderBook
    limitOrderBook2: TestLimitOrderBook
}

interface UniswapV3BrokerFixture {
    uniswapV3Broker: TestUniswapV3Broker
}

export enum BaseQuoteOrdering {
    BASE_0_QUOTE_1,
    BASE_1_QUOTE_0,
}

// 1. caller of this function should ensure that (base, quote) = (token0, token1) is always true
// 2. ideally there should be no test using `canMockTime` as false as it can result in flaky test results (usually related to funding calculation)
//    but keeping this param and the comment here for notifying this issue; can see time.ts for more info
export function createClearingHouseFixture(
    canMockTime: boolean = true,
    uniFeeTier = 10000, // 1%
): () => Promise<ClearingHouseFixture> {
    return async (): Promise<ClearingHouseFixture> => {
        const [admin] = waffle.provider.getWallets()
        // deploy test tokens
        const tokenFactory = await ethers.getContractFactory("TestERC20")
        const USDC = (await tokenFactory.deploy()) as TestERC20
        await USDC.__TestERC20_init("TestUSDC", "USDC", USDC_DECIMALS)
        const WETH = (await tokenFactory.deploy()) as TestERC20
        await WETH.__TestERC20_init("TestWETH", "WETH", WETH_DECIMALS)
        const WBTC = (await tokenFactory.deploy()) as TestERC20
        await WBTC.__TestERC20_init("TestWBTC", "WBTC", WBTC_DECIMALS)

        const usdcDecimals = await USDC.decimals()

        let baseToken: BaseToken, quoteToken: QuoteToken
        const { token0, mockedPriceFeedDispatcher, token1 } = await tokensFixture()

        // price feed for weth and wbtc
        const aggregatorFactory = await ethers.getContractFactory("TestAggregatorV3")
        const aggregator = await aggregatorFactory.deploy()
        const mockedAggregator = await smockit(aggregator)
        mockedAggregator.smocked.decimals.will.return.with(async () => {
            return CHAINLINK_AGGREGATOR_DECIMALS
        })

        const chainlinkPriceFeedV3Factory = await ethers.getContractFactory("ChainlinkPriceFeedV3")
        const wethChainlinkPriceFeedV3 = (await chainlinkPriceFeedV3Factory.deploy(
            mockedAggregator.address,
            40 * 60, // 40 mins
            CACHED_TWAP_INTERVAL,
        )) as ChainlinkPriceFeedV3
        const wbtcChainlinkPriceFeedV3 = (await chainlinkPriceFeedV3Factory.deploy(
            mockedAggregator.address,
            40 * 60, // 40 mins
            CACHED_TWAP_INTERVAL,
        )) as ChainlinkPriceFeedV3

        const chainlinkPriceFeedFactory = await ethers.getContractFactory("ChainlinkPriceFeedV2")
        const wethPriceFeed = (await chainlinkPriceFeedFactory.deploy(aggregator.address, 0)) as ChainlinkPriceFeedV2
        const mockedWethPriceFeed = await smockit(wethPriceFeed)
        const wbtcPriceFeed = (await chainlinkPriceFeedFactory.deploy(aggregator.address, 0)) as ChainlinkPriceFeedV2
        const mockedWbtcPriceFeed = await smockit(wbtcPriceFeed)
        mockedWethPriceFeed.smocked.decimals.will.return.with(8)
        mockedWbtcPriceFeed.smocked.decimals.will.return.with(8)

        const priceFeedDispatcherFactory = await ethers.getContractFactory("PriceFeedDispatcher")
        const wethPriceFeedDispatcher = (await priceFeedDispatcherFactory.deploy(
            wethChainlinkPriceFeedV3.address,
        )) as PriceFeedDispatcher
        const mockedWethPriceFeedDispatcher = await smockit(wethPriceFeedDispatcher)
        mockedWethPriceFeedDispatcher.smocked.decimals.will.return.with(async () => {
            return PRICEFEED_DISPATCHER_DECIMALS
        })

        const wbtcPriceFeedDispatcher = (await priceFeedDispatcherFactory.deploy(
            wbtcChainlinkPriceFeedV3.address,
        )) as PriceFeedDispatcher
        const mockedWbtcPriceFeedDispatcher = await smockit(wbtcPriceFeedDispatcher)
        mockedWbtcPriceFeedDispatcher.smocked.decimals.will.return.with(async () => {
            return PRICEFEED_DISPATCHER_DECIMALS
        })

        // we assume (base, quote) == (token0, token1)
        baseToken = token0
        quoteToken = token1

        // deploy UniV3 factory
        const factoryFactory = await ethers.getContractFactory("UniswapV3Factory")
        const uniV3Factory = (await factoryFactory.deploy()) as UniswapV3Factory

        const clearingHouseConfigFactory = await ethers.getContractFactory("ClearingHouseConfig")
        const clearingHouseConfig = (await clearingHouseConfigFactory.deploy()) as ClearingHouseConfig
        await clearingHouseConfig.initialize()

        // prepare uniswap factory
        await uniV3Factory.createPool(baseToken.address, quoteToken.address, uniFeeTier)
        const poolFactory = await ethers.getContractFactory("UniswapV3Pool")

        const marketRegistryFactory = await ethers.getContractFactory("MarketRegistry")
        const marketRegistry = (await marketRegistryFactory.deploy()) as MarketRegistry
        await marketRegistry.initialize(uniV3Factory.address, quoteToken.address)

        const orderBookFactory = await ethers.getContractFactory("OrderBook")
        const orderBook = (await orderBookFactory.deploy()) as OrderBook
        await orderBook.initialize(marketRegistry.address)

        let accountBalance
        let exchange
        if (canMockTime) {
            const accountBalanceFactory = await ethers.getContractFactory("TestAccountBalance")
            accountBalance = (await accountBalanceFactory.deploy()) as TestAccountBalance

            const exchangeFactory = await ethers.getContractFactory("TestExchange")
            exchange = (await exchangeFactory.deploy()) as TestExchange
        } else {
            const accountBalanceFactory = await ethers.getContractFactory("AccountBalance")
            accountBalance = (await accountBalanceFactory.deploy()) as AccountBalance

            const exchangeFactory = await ethers.getContractFactory("Exchange")
            exchange = (await exchangeFactory.deploy()) as Exchange
        }

        const insuranceFundFactory = await ethers.getContractFactory("InsuranceFund")
        const insuranceFund = (await insuranceFundFactory.deploy()) as InsuranceFund
        await insuranceFund.initialize(USDC.address)

        // deploy exchange
        await exchange.initialize(marketRegistry.address, orderBook.address, clearingHouseConfig.address)
        await exchange.setAccountBalance(accountBalance.address)

        await orderBook.setExchange(exchange.address)

        await accountBalance.initialize(clearingHouseConfig.address, orderBook.address)

        // deploy vault
        const vaultFactory = await ethers.getContractFactory("TestVault")
        const vault = (await vaultFactory.deploy()) as Vault
        await vault.initialize(
            insuranceFund.address,
            clearingHouseConfig.address,
            accountBalance.address,
            exchange.address,
        )

        const collateralManagerFactory = await ethers.getContractFactory("CollateralManager")
        const collateralManager = (await collateralManagerFactory.deploy()) as CollateralManager
        await collateralManager.initialize(
            clearingHouseConfig.address,
            vault.address,
            5, // maxCollateralTokensPerAccount
            "750000", // debtNonSettlementTokenValueRatio
            "500000", // liquidationRatio
            "2000", // mmRatioBuffer
            "30000", // clInsuranceFundFeeRatio
            parseUnits("10000", usdcDecimals), // debtThreshold
            parseUnits("500", usdcDecimals), // collateralValueDust
        )
        await collateralManager.addCollateral(WETH.address, {
            priceFeed: mockedWethPriceFeed.address,
            collateralRatio: (0.7e6).toString(),
            discountRatio: (0.1e6).toString(),
            depositCap: parseEther("1000"),
        })
        await collateralManager.addCollateral(WBTC.address, {
            priceFeed: mockedWbtcPriceFeed.address,
            collateralRatio: (0.7e6).toString(),
            discountRatio: (0.1e6).toString(),
            depositCap: parseUnits("1000", await WBTC.decimals()),
        })

        await vault.setCollateralManager(collateralManager.address)
        await insuranceFund.setVault(vault.address)
        await accountBalance.setVault(vault.address)

        // deploy a pool
        const poolAddr = await uniV3Factory.getPool(baseToken.address, quoteToken.address, uniFeeTier)
        const pool = poolFactory.attach(poolAddr) as UniswapV3Pool
        await baseToken.addWhitelist(pool.address)
        await quoteToken.addWhitelist(pool.address)

        // deploy another pool
        const _token0Fixture = await token0Fixture(quoteToken.address)
        const baseToken2 = _token0Fixture.baseToken
        const mockedPriceFeedDispatcher2 = _token0Fixture.mockedPriceFeedDispatcher
        await uniV3Factory.createPool(baseToken2.address, quoteToken.address, uniFeeTier)
        const pool2Addr = await uniV3Factory.getPool(baseToken2.address, quoteToken.address, uniFeeTier)
        const pool2 = poolFactory.attach(pool2Addr) as UniswapV3Pool

        await baseToken2.addWhitelist(pool2.address)
        await quoteToken.addWhitelist(pool2.address)

        // deploy clearingHouse
        let clearingHouse: ClearingHouse | TestClearingHouse
        if (canMockTime) {
            const clearingHouseFactory = await ethers.getContractFactory("TestClearingHouse")
            const testClearingHouse = (await clearingHouseFactory.deploy()) as TestClearingHouse
            await testClearingHouse.__TestClearingHouse_init(
                clearingHouseConfig.address,
                vault.address,
                quoteToken.address,
                uniV3Factory.address,
                exchange.address,
                accountBalance.address,
                insuranceFund.address,
            )
            clearingHouse = testClearingHouse
        } else {
            const clearingHouseFactory = await ethers.getContractFactory("ClearingHouse")
            clearingHouse = (await clearingHouseFactory.deploy()) as ClearingHouse
            await clearingHouse.initialize(
                clearingHouseConfig.address,
                vault.address,
                quoteToken.address,
                uniV3Factory.address,
                exchange.address,
                accountBalance.address,
                insuranceFund.address,
            )
        }

        await clearingHouseConfig.setSettlementTokenBalanceCap(ethers.constants.MaxUint256)
        await quoteToken.mintMaximumTo(clearingHouse.address)
        await baseToken.mintMaximumTo(clearingHouse.address)
        await baseToken2.mintMaximumTo(clearingHouse.address)
        await quoteToken.addWhitelist(clearingHouse.address)
        await baseToken.addWhitelist(clearingHouse.address)
        await baseToken2.addWhitelist(clearingHouse.address)
        await marketRegistry.setClearingHouse(clearingHouse.address)
        await marketRegistry.setFeeManager(admin.address, true)
        await orderBook.setClearingHouse(clearingHouse.address)
        await exchange.setClearingHouse(clearingHouse.address)
        await accountBalance.setClearingHouse(clearingHouse.address)
        await vault.setClearingHouse(clearingHouse.address)

        return {
            clearingHouse,
            orderBook,
            accountBalance,
            marketRegistry,
            clearingHouseConfig,
            exchange,
            vault,
            insuranceFund,
            collateralManager,
            uniV3Factory,
            pool,
            uniFeeTier,
            USDC,
            WETH,
            WBTC,
            mockedPriceFeedDispatcher,
            mockedWethPriceFeed,
            mockedWbtcPriceFeed,
            mockedWethPriceFeedDispatcher,
            mockedWbtcPriceFeedDispatcher,
            quoteToken,
            baseToken,
            baseToken2,
            mockedPriceFeedDispatcher2,
            pool2,
        }
    }
}

export async function uniswapV3BrokerFixture(): Promise<UniswapV3BrokerFixture> {
    const factory = await uniswapV3FactoryFixture()
    const uniswapV3BrokerFactory = await ethers.getContractFactory("TestUniswapV3Broker")
    const uniswapV3Broker = (await uniswapV3BrokerFactory.deploy()) as TestUniswapV3Broker
    await uniswapV3Broker.initialize(factory.address)
    return { uniswapV3Broker }
}

interface MockedClearingHouseFixture {
    clearingHouse: ClearingHouse
    clearingHouseConfig: ClearingHouseConfig
    exchange: Exchange
    mockedUniV3Factory: MockContract
    mockedVault: MockContract
    mockedQuoteToken: MockContract
    mockedUSDC: MockContract
    mockedBaseToken: MockContract
    mockedExchange: MockContract
    mockedInsuranceFund: MockContract
    mockedAccountBalance: MockContract
    mockedMarketRegistry: MockContract
}

const ADDR_GREATER_THAN = true
const ADDR_LESS_THAN = false

async function mockedBaseTokenToken(longerThan: boolean, targetAddr: string): Promise<MockContract> {
    // deployer ensure base token is always smaller than quote in order to achieve base=token0 and quote=token1
    let mockedToken: MockContract
    while (
        !mockedToken ||
        (longerThan
            ? mockedToken.address.toLowerCase() <= targetAddr.toLowerCase()
            : mockedToken.address.toLowerCase() >= targetAddr.toLowerCase())
    ) {
        const aggregatorFactory = await ethers.getContractFactory("TestAggregatorV3")
        const aggregator = await aggregatorFactory.deploy()
        const mockedAggregator = await smockit(aggregator)

        mockedAggregator.smocked.decimals.will.return.with(async () => {
            return CHAINLINK_AGGREGATOR_DECIMALS
        })

        const chainlinkPriceFeedV3Factory = await ethers.getContractFactory("ChainlinkPriceFeedV3")
        const chainlinkPriceFeed = (await chainlinkPriceFeedV3Factory.deploy(
            mockedAggregator.address,
            40 * 60, // 40 mins
            CACHED_TWAP_INTERVAL,
        )) as ChainlinkPriceFeedV3
        const priceFeedDispatcherFactory = await ethers.getContractFactory("PriceFeedDispatcher")
        const priceFeedDispatcher = (await priceFeedDispatcherFactory.deploy(
            chainlinkPriceFeed.address,
        )) as PriceFeedDispatcher

        const baseTokenFactory = await ethers.getContractFactory("BaseToken")
        const token = (await baseTokenFactory.deploy()) as BaseToken
        await token.initialize("Test", "Test", priceFeedDispatcher.address)
        mockedToken = await smockit(token)
        mockedToken.smocked.decimals.will.return.with(async () => {
            return 18
        })
    }
    return mockedToken
}

export async function mockedClearingHouseFixture(): Promise<MockedClearingHouseFixture> {
    const token1 = await createQuoteTokenFixture("RandomVirtualToken", "RVT")()

    // deploy test tokens
    const tokenFactory = await ethers.getContractFactory("TestERC20")
    const USDC = (await tokenFactory.deploy()) as TestERC20
    await USDC.__TestERC20_init("TestUSDC", "USDC", 6)

    const insuranceFundFactory = await ethers.getContractFactory("InsuranceFund")
    const insuranceFund = (await insuranceFundFactory.deploy()) as InsuranceFund
    const mockedInsuranceFund = await smockit(insuranceFund)

    const vaultFactory = await ethers.getContractFactory("Vault")
    const vault = (await vaultFactory.deploy()) as Vault
    const mockedVault = await smockit(vault)

    const mockedUSDC = await smockit(USDC)
    const mockedQuoteToken = await smockit(token1)
    mockedQuoteToken.smocked.decimals.will.return.with(async () => {
        return 18
    })

    // deploy UniV3 factory
    const factoryFactory = await ethers.getContractFactory("UniswapV3Factory")
    const uniV3Factory = (await factoryFactory.deploy()) as UniswapV3Factory
    const mockedUniV3Factory = await smockit(uniV3Factory)

    const clearingHouseConfigFactory = await ethers.getContractFactory("ClearingHouseConfig")
    const clearingHouseConfig = (await clearingHouseConfigFactory.deploy()) as ClearingHouseConfig

    const marketRegistryFactory = await ethers.getContractFactory("MarketRegistry")
    const marketRegistry = (await marketRegistryFactory.deploy()) as MarketRegistry
    await marketRegistry.initialize(mockedUniV3Factory.address, mockedQuoteToken.address)
    const mockedMarketRegistry = await smockit(marketRegistry)
    const orderBookFactory = await ethers.getContractFactory("OrderBook")
    const orderBook = (await orderBookFactory.deploy()) as OrderBook
    await orderBook.initialize(marketRegistry.address)
    const mockedOrderBook = await smockit(orderBook)

    const exchangeFactory = await ethers.getContractFactory("Exchange")
    const exchange = (await exchangeFactory.deploy()) as Exchange
    await exchange.initialize(mockedMarketRegistry.address, mockedOrderBook.address, clearingHouseConfig.address)
    const mockedExchange = await smockit(exchange)

    const accountBalanceFactory = await ethers.getContractFactory("AccountBalance")
    const accountBalance = (await accountBalanceFactory.deploy()) as AccountBalance
    const mockedAccountBalance = await smockit(accountBalance)

    // deployer ensure base token is always smaller than quote in order to achieve base=token0 and quote=token1
    const mockedBaseToken = await mockedBaseTokenToken(ADDR_LESS_THAN, mockedQuoteToken.address)

    mockedExchange.smocked.getOrderBook.will.return.with(mockedOrderBook.address)

    // deploy clearingHouse
    const clearingHouseFactory = await ethers.getContractFactory("ClearingHouse")
    const clearingHouse = (await clearingHouseFactory.deploy()) as ClearingHouse
    await clearingHouse.initialize(
        clearingHouseConfig.address,
        mockedVault.address,
        mockedQuoteToken.address,
        mockedUniV3Factory.address,
        mockedExchange.address,
        mockedAccountBalance.address,
        insuranceFund.address,
    )
    return {
        clearingHouse,
        clearingHouseConfig,
        exchange,
        mockedExchange,
        mockedUniV3Factory,
        mockedVault,
        mockedQuoteToken,
        mockedUSDC,
        mockedBaseToken,
        mockedInsuranceFund,
        mockedAccountBalance,
        mockedMarketRegistry,
    }
}

export function createClearingHouseWithDelegateApprovalFixture(): () => Promise<ClearingHouseWithDelegateApprovalFixture> {
    return async (): Promise<ClearingHouseWithDelegateApprovalFixture> => {
        const clearingHouseFixture = await createClearingHouseFixture()()
        const clearingHouse = clearingHouseFixture.clearingHouse as TestClearingHouse

        const delegateApprovalFactory = await ethers.getContractFactory("DelegateApproval")
        const delegateApproval = await delegateApprovalFactory.deploy()
        await delegateApproval.initialize()

        const testLimitOrderBookFactory = await ethers.getContractFactory("TestLimitOrderBook")
        const testLimitOrderBook = await testLimitOrderBookFactory.deploy(clearingHouse.address)
        const testLimitOrderBook2 = await testLimitOrderBookFactory.deploy(clearingHouse.address)

        await clearingHouse.setDelegateApproval(delegateApproval.address)

        return {
            ...clearingHouseFixture,
            delegateApproval,
            clearingHouseOpenPositionAction: await delegateApproval.getClearingHouseOpenPositionAction(),
            clearingHouseAddLiquidityAction: await delegateApproval.getClearingHouseAddLiquidityAction(),
            clearingHouseRemoveLiquidityAction: await delegateApproval.getClearingHouseRemoveLiquidityAction(),
            notExistedAction: 64,
            notExistedAction2: 128,
            limitOrderBook: testLimitOrderBook,
            limitOrderBook2: testLimitOrderBook2,
        }
    }
}
