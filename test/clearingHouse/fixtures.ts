import { MockContract, smockit } from "@eth-optimism/smock"
import { ethers } from "hardhat"
import {
    BaseToken,
    ChainlinkPriceFeed,
    ClearingHouse,
    ClearingHouseConfig,
    Exchange,
    InsuranceFund,
    TestClearingHouse,
    TestERC20,
    TestUniswapV3Broker,
    UniswapV3Factory,
    UniswapV3Pool,
    Vault,
} from "../../typechain"
import { QuoteToken } from "../../typechain/QuoteToken"
import { createQuoteTokenFixture, token0Fixture, tokensFixture, uniswapV3FactoryFixture } from "../shared/fixtures"

interface ClearingHouseFixture {
    clearingHouse: TestClearingHouse | ClearingHouse
    clearingHouseConfig: ClearingHouseConfig
    exchange: Exchange
    vault: Vault
    insuranceFund: InsuranceFund
    uniV3Factory: UniswapV3Factory
    pool: UniswapV3Pool
    feeTier: number
    USDC: TestERC20
    quoteToken: QuoteToken
    baseToken: BaseToken
    mockedBaseAggregator: MockContract
    baseToken2: BaseToken
    mockedBaseAggregator2: MockContract
    pool2: UniswapV3Pool
    mockedArbSys: MockContract
}

interface UniswapV3BrokerFixture {
    uniswapV3Broker: TestUniswapV3Broker
}

export enum BaseQuoteOrdering {
    BASE_0_QUOTE_1,
    BASE_1_QUOTE_0,
}

export function createClearingHouseFixture(
    baseQuoteOrdering: BaseQuoteOrdering = BaseQuoteOrdering.BASE_0_QUOTE_1, // TODO remove
    canMockTime: boolean = true,
): () => Promise<ClearingHouseFixture> {
    return async (): Promise<ClearingHouseFixture> => {
        // deploy test tokens
        const tokenFactory = await ethers.getContractFactory("TestERC20")
        const USDC = (await tokenFactory.deploy()) as TestERC20
        await USDC.initialize("TestUSDC", "USDC")
        await USDC.setupDecimals(6)

        let baseToken: BaseToken, quoteToken: QuoteToken, mockedBaseAggregator: MockContract
        const { token0, mockedAggregator0, token1 } = await tokensFixture()

        if (baseQuoteOrdering === BaseQuoteOrdering.BASE_0_QUOTE_1) {
            baseToken = token0
            quoteToken = token1
            mockedBaseAggregator = mockedAggregator0
        } else {
            throw new Error("!B1Q0")
        }

        // deploy UniV3 factory
        const factoryFactory = await ethers.getContractFactory("UniswapV3Factory")
        const uniV3Factory = (await factoryFactory.deploy()) as UniswapV3Factory

        const vaultFactory = await ethers.getContractFactory("Vault")
        const vault = (await vaultFactory.deploy()) as Vault
        await vault.initialize(USDC.address)

        const insuranceFundFactory = await ethers.getContractFactory("InsuranceFund")
        const insuranceFund = (await insuranceFundFactory.deploy()) as InsuranceFund
        await insuranceFund.initialize(vault.address)

        const clearingHouseConfigFactory = await ethers.getContractFactory("ClearingHouseConfig")
        const clearingHouseConfig = (await clearingHouseConfigFactory.deploy()) as ClearingHouseConfig
        await clearingHouseConfig.initialize()

        // deploy clearingHouse
        let clearingHouse: ClearingHouse | TestClearingHouse
        if (canMockTime) {
            const clearingHouseFactory = await ethers.getContractFactory("TestClearingHouse")
            clearingHouse = (await clearingHouseFactory.deploy()) as TestClearingHouse
            await clearingHouse.initialize(
                clearingHouseConfig.address,
                vault.address,
                insuranceFund.address,
                quoteToken.address,
                uniV3Factory.address,
            )
        } else {
            const clearingHouseFactory = await ethers.getContractFactory("ClearingHouse")
            clearingHouse = (await clearingHouseFactory.deploy()) as ClearingHouse
            await clearingHouse.initialize(
                clearingHouseConfig.address,
                vault.address,
                insuranceFund.address,
                quoteToken.address,
                uniV3Factory.address,
            )
        }

        await quoteToken.addWhitelist(clearingHouse.address)

        // set CH as the minter of all virtual tokens
        await vault.setClearingHouse(clearingHouse.address)
        await baseToken.mintMaximumTo(clearingHouse.address)
        await quoteToken.mintMaximumTo(clearingHouse.address)

        // prepare uniswap factory
        const feeTier = 10000
        await uniV3Factory.createPool(baseToken.address, quoteToken.address, feeTier)
        const poolFactory = await ethers.getContractFactory("UniswapV3Pool")

        // deploy exchange
        const exchangeFactory = await ethers.getContractFactory("Exchange")
        const exchange = (await exchangeFactory.deploy()) as Exchange
        await exchange.initialize(clearingHouse.address, uniV3Factory.address, quoteToken.address)
        await clearingHouse.setExchange(exchange.address)

        // deploy a pool
        const poolAddr = await uniV3Factory.getPool(baseToken.address, quoteToken.address, feeTier)
        const pool = poolFactory.attach(poolAddr) as UniswapV3Pool
        await baseToken.addWhitelist(clearingHouse.address)
        await baseToken.addWhitelist(pool.address)
        await quoteToken.addWhitelist(pool.address)

        // deploy another pool
        const _token0Fixture = await token0Fixture(quoteToken.address)
        const baseToken2 = _token0Fixture.baseToken
        await baseToken2.mintMaximumTo(clearingHouse.address)
        const mockedBaseAggregator2 = _token0Fixture.mockedAggregator
        await uniV3Factory.createPool(baseToken2.address, quoteToken.address, feeTier)
        const pool2Addr = await uniV3Factory.getPool(baseToken2.address, quoteToken.address, feeTier)
        const pool2 = poolFactory.attach(pool2Addr) as UniswapV3Pool

        await baseToken2.addWhitelist(clearingHouse.address)
        await baseToken2.addWhitelist(pool2.address)
        await quoteToken.addWhitelist(pool2.address)

        const mockedArbSys = await getMockedArbSys()
        return {
            clearingHouse,
            clearingHouseConfig,
            exchange,
            vault,
            insuranceFund,
            uniV3Factory,
            pool,
            feeTier,
            USDC,
            quoteToken,
            baseToken,
            mockedBaseAggregator,
            baseToken2,
            mockedBaseAggregator2,
            pool2,
            mockedArbSys,
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
    mockedUniV3Factory: MockContract
    mockedVault: MockContract
    mockedQuoteToken: MockContract
    mockedUSDC: MockContract
    mockedBaseToken: MockContract
    mockedExchange: MockContract
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
        const chainlinkPriceFeed = (await chainlinkPriceFeedFactory.deploy()) as ChainlinkPriceFeed
        await chainlinkPriceFeed.initialize(mockedAggregator.address)

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

async function getMockedArbSys(): Promise<MockContract> {
    const arbSysFactory = await ethers.getContractFactory("TestArbSys")
    const arbSys = await arbSysFactory.deploy()
    const mockedArbSys = await smockit(arbSys, { address: "0x0000000000000000000000000000000000000064" })
    mockedArbSys.smocked.arbBlockNumber.will.return.with(async () => {
        return 1
    })
    return mockedArbSys
}

export async function mockedClearingHouseFixture(): Promise<MockedClearingHouseFixture> {
    const token1 = await createQuoteTokenFixture("RandomVirtualToken", "RVT")()

    // deploy test tokens
    const tokenFactory = await ethers.getContractFactory("TestERC20")
    const USDC = (await tokenFactory.deploy()) as TestERC20
    await USDC.initialize("TestUSDC", "USDC")
    const vaultFactory = await ethers.getContractFactory("Vault")
    const vault = (await vaultFactory.deploy()) as Vault
    await vault.initialize(USDC.address)
    const insuranceFundFactory = await ethers.getContractFactory("InsuranceFund")
    const insuranceFund = (await insuranceFundFactory.deploy()) as InsuranceFund
    await insuranceFund.initialize(vault.address)

    const mockedUSDC = await smockit(USDC)
    const mockedQuoteToken = await smockit(token1)
    mockedQuoteToken.smocked.decimals.will.return.with(async () => {
        return 18
    })

    const mockedVault = await smockit(vault)
    const mockedInsuranceFund = await smockit(insuranceFund)

    // deploy UniV3 factory
    const factoryFactory = await ethers.getContractFactory("UniswapV3Factory")
    const uniV3Factory = (await factoryFactory.deploy()) as UniswapV3Factory
    const mockedUniV3Factory = await smockit(uniV3Factory)

    const clearingHouseConfigFactory = await ethers.getContractFactory("ClearingHouseConfig")
    const clearingHouseConfig = (await clearingHouseConfigFactory.deploy()) as ClearingHouseConfig

    // deploy clearingHouse
    const clearingHouseFactory = await ethers.getContractFactory("ClearingHouse")
    const clearingHouse = (await clearingHouseFactory.deploy()) as ClearingHouse
    await clearingHouse.initialize(
        clearingHouseConfig.address,
        mockedVault.address,
        mockedInsuranceFund.address,
        mockedQuoteToken.address,
        mockedUniV3Factory.address,
    )

    const exchangeFactory = await ethers.getContractFactory("Exchange")
    const exchange = (await exchangeFactory.deploy()) as Exchange
    await exchange.initialize(clearingHouse.address, mockedUniV3Factory.address, mockedQuoteToken.address)
    const mockedExchange = await smockit(exchange)
    await clearingHouse.setExchange(mockedExchange.address)

    // deployer ensure base token is always smaller than quote in order to achieve base=token0 and quote=token1
    const mockedBaseToken = await mockedBaseTokenTo(ADDR_LESS_THAN, mockedQuoteToken.address)

    return {
        clearingHouse,
        clearingHouseConfig,
        mockedExchange,
        mockedUniV3Factory,
        mockedVault,
        mockedQuoteToken,
        mockedUSDC,
        mockedBaseToken,
    }
}
