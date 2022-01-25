import { MockContract, smockit } from "@eth-optimism/smock"
import { ethers } from "hardhat"
import {
    AccountBalance,
    BaseToken,
    ClearingHouse,
    ClearingHouseConfig,
    Exchange,
    InsuranceFund,
    MarketRegistry,
    OrderBook,
    TestClearingHouse,
    TestERC20,
    TestExchange,
    TestUniswapV3Broker,
    UniswapV3Factory,
    UniswapV3Pool,
    Vault,
} from "../../typechain"
import { ChainlinkPriceFeed } from "../../typechain/perp-oracle"
import { QuoteToken } from "../../typechain/QuoteToken"
import { TestAccountBalance } from "../../typechain/TestAccountBalance"
import { createQuoteTokenFixture, token0Fixture, tokensFixture, uniswapV3FactoryFixture } from "../shared/fixtures"

export interface ClearingHouseFixture {
    clearingHouse: TestClearingHouse | ClearingHouse
    orderBook: OrderBook
    accountBalance: TestAccountBalance | AccountBalance
    marketRegistry: MarketRegistry
    clearingHouseConfig: ClearingHouseConfig
    exchange: TestExchange | Exchange
    vault: Vault
    insuranceFund: InsuranceFund
    uniV3Factory: UniswapV3Factory
    pool: UniswapV3Pool
    uniFeeTier: number
    USDC: TestERC20
    quoteToken: QuoteToken
    baseToken: BaseToken
    mockedBaseAggregator: MockContract
    baseToken2: BaseToken
    mockedBaseAggregator2: MockContract
    pool2: UniswapV3Pool
}

interface UniswapV3BrokerFixture {
    uniswapV3Broker: TestUniswapV3Broker
}

export enum BaseQuoteOrdering {
    BASE_0_QUOTE_1,
    BASE_1_QUOTE_0,
}

// caller of this function should ensure that (base, quote) = (token0, token1) is always true
export function createClearingHouseFixture(
    canMockTime: boolean = true,
    uniFeeTier = 10000, // 1%
): () => Promise<ClearingHouseFixture> {
    return async (): Promise<ClearingHouseFixture> => {
        // deploy test tokens
        const tokenFactory = await ethers.getContractFactory("TestERC20")
        const USDC = (await tokenFactory.deploy()) as TestERC20
        await USDC.__TestERC20_init("TestUSDC", "USDC", 6)

        let baseToken: BaseToken, quoteToken: QuoteToken, mockedBaseAggregator: MockContract
        const { token0, mockedAggregator0, token1 } = await tokensFixture()

        // we assume (base, quote) == (token0, token1)
        baseToken = token0
        quoteToken = token1
        mockedBaseAggregator = mockedAggregator0

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
        exchange.setAccountBalance(accountBalance.address)

        await orderBook.setExchange(exchange.address)

        await accountBalance.initialize(clearingHouseConfig.address, orderBook.address)

        const vaultFactory = await ethers.getContractFactory("Vault")
        const vault = (await vaultFactory.deploy()) as Vault
        await vault.initialize(
            insuranceFund.address,
            clearingHouseConfig.address,
            accountBalance.address,
            exchange.address,
        )
        await insuranceFund.setBorrower(vault.address)
        await accountBalance.setVault(vault.address)

        // deploy a pool
        const poolAddr = await uniV3Factory.getPool(baseToken.address, quoteToken.address, uniFeeTier)
        const pool = poolFactory.attach(poolAddr) as UniswapV3Pool
        await baseToken.addWhitelist(pool.address)
        await quoteToken.addWhitelist(pool.address)

        // deploy another pool
        const _token0Fixture = await token0Fixture(quoteToken.address)
        const baseToken2 = _token0Fixture.baseToken
        const mockedBaseAggregator2 = _token0Fixture.mockedAggregator
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
            uniV3Factory,
            pool,
            uniFeeTier,
            USDC,
            quoteToken,
            baseToken,
            mockedBaseAggregator,
            baseToken2,
            mockedBaseAggregator2,
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

export const ADDR_GREATER_THAN = true
export const ADDR_LESS_THAN = false
export async function mockedBaseTokenTo(longerThan: boolean, targetAddr: string): Promise<MockContract> {
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

        const chainlinkPriceFeedFactory = await ethers.getContractFactory("ChainlinkPriceFeed")
        const chainlinkPriceFeed = (await chainlinkPriceFeedFactory.deploy(
            mockedAggregator.address,
        )) as ChainlinkPriceFeed

        const baseTokenFactory = await ethers.getContractFactory("BaseToken")
        const token = (await baseTokenFactory.deploy()) as BaseToken
        await token.initialize("Test", "Test", chainlinkPriceFeed.address)
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
    const mockedBaseToken = await mockedBaseTokenTo(ADDR_LESS_THAN, mockedQuoteToken.address)

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
