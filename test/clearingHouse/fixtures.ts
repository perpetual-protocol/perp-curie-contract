import { MockContract, smockit } from "@eth-optimism/smock"
import { ethers } from "hardhat"
import {
    ClearingHouse,
    Exchange,
    InsuranceFund,
    TestClearingHouse,
    TestERC20,
    TestUniswapV3Broker,
    UniswapV3Factory,
    UniswapV3Pool,
    Vault,
} from "../../typechain"
import { VirtualToken } from "../../typechain/VirtualToken"
import { token0Fixture, tokensFixture, uniswapV3FactoryFixture } from "../shared/fixtures"

interface ClearingHouseFixture {
    clearingHouse: TestClearingHouse | ClearingHouse
    exchange: Exchange
    vault: Vault
    insuranceFund: InsuranceFund
    uniV3Factory: UniswapV3Factory
    pool: UniswapV3Pool
    feeTier: number
    USDC: TestERC20
    quoteToken: VirtualToken
    baseToken: VirtualToken
    mockedBaseAggregator: MockContract
    baseToken2: VirtualToken
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
    baseQuoteOrdering: BaseQuoteOrdering = BaseQuoteOrdering.BASE_0_QUOTE_1,
    canMockTime: boolean = true,
): () => Promise<ClearingHouseFixture> {
    return async (): Promise<ClearingHouseFixture> => {
        // deploy test tokens
        const tokenFactory = await ethers.getContractFactory("TestERC20")
        const USDC = (await tokenFactory.deploy("TestUSDC", "USDC")) as TestERC20
        await USDC.setupDecimals(6)

        let baseToken: VirtualToken, quoteToken: VirtualToken, mockedBaseAggregator: MockContract
        const { token0, mockedAggregator0, token1, mockedAggregator1 } = await tokensFixture()

        if (baseQuoteOrdering === BaseQuoteOrdering.BASE_0_QUOTE_1) {
            baseToken = token0
            quoteToken = token1
            mockedBaseAggregator = mockedAggregator0
        } else {
            baseToken = token1
            quoteToken = token0
            mockedBaseAggregator = mockedAggregator1
        }

        // deploy UniV3 factory
        const factoryFactory = await ethers.getContractFactory("UniswapV3Factory")
        const uniV3Factory = (await factoryFactory.deploy()) as UniswapV3Factory

        const vaultFactory = await ethers.getContractFactory("Vault")
        const vault = (await vaultFactory.deploy(USDC.address)) as Vault

        const insuranceFundFactory = await ethers.getContractFactory("InsuranceFund")
        const insuranceFund = (await insuranceFundFactory.deploy(vault.address)) as InsuranceFund

        // deploy clearingHouse
        let clearingHouse: ClearingHouse | TestClearingHouse
        if (canMockTime) {
            const clearingHouseFactory = await ethers.getContractFactory("TestClearingHouse")
            clearingHouse = (await clearingHouseFactory.deploy(
                vault.address,
                insuranceFund.address,
                quoteToken.address,
                uniV3Factory.address,
            )) as TestClearingHouse
        } else {
            const clearingHouseFactory = await ethers.getContractFactory("ClearingHouse")
            clearingHouse = (await clearingHouseFactory.deploy(
                vault.address,
                insuranceFund.address,
                quoteToken.address,
                uniV3Factory.address,
            )) as ClearingHouse
        }

        await quoteToken.addWhitelist(clearingHouse.address)

        // set CH as the minter of all virtual tokens
        await vault.setClearingHouse(clearingHouse.address)
        await baseToken.setMinter(clearingHouse.address)
        await quoteToken.setMinter(clearingHouse.address)

        // prepare uniswap factory
        const feeTier = 10000
        await uniV3Factory.createPool(baseToken.address, quoteToken.address, feeTier)
        const poolFactory = await ethers.getContractFactory("UniswapV3Pool")

        // deploy exchange
        const exchangeFactory = await ethers.getContractFactory("Exchange")
        const exchange = (await exchangeFactory.deploy(
            clearingHouse.address,
            uniV3Factory.address,
            quoteToken.address,
        )) as Exchange
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
        await baseToken2.setMinter(clearingHouse.address)
        const mockedBaseAggregator2 = _token0Fixture.mockedAggregator
        await uniV3Factory.createPool(baseToken2.address, quoteToken.address, feeTier)
        const pool2Addr = await uniV3Factory.getPool(baseToken2.address, quoteToken.address, feeTier)
        const pool2 = poolFactory.attach(pool2Addr) as UniswapV3Pool

        await baseToken2.addWhitelist(clearingHouse.address)
        await baseToken2.addWhitelist(pool2.address)
        await quoteToken.addWhitelist(pool2.address)

        await clearingHouse.setFeeRatio(baseToken.address, feeTier)
        await clearingHouse.setFeeRatio(baseToken2.address, feeTier)

        const mockedArbSys = await getMockedArbSys()
        return {
            clearingHouse,
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
    const uniswapV3Broker = (await uniswapV3BrokerFactory.deploy(factory.address)) as TestUniswapV3Broker
    return { uniswapV3Broker }
}

interface MockedClearingHouseFixture {
    clearingHouse: ClearingHouse
    mockedUniV3Factory: MockContract
    mockedVault: MockContract
    mockedQuoteToken: MockContract
    mockedUSDC: MockContract
    mockedBaseToken: MockContract
    mockedExchange: MockContract
}

export const ADDR_GREATER_THAN = true
export const ADDR_LESS_THAN = false
export async function mockedTokenTo(longerThan: boolean, targetAddr: string): Promise<MockContract> {
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
        const chainlinkPriceFeed = await chainlinkPriceFeedFactory.deploy(mockedAggregator.address)

        const virtualTokenFactory = await ethers.getContractFactory("VirtualToken")
        const token = (await virtualTokenFactory.deploy("Test", "Test", chainlinkPriceFeed.address)) as VirtualToken
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
    const { token1 } = await tokensFixture()

    // deploy test tokens
    const tokenFactory = await ethers.getContractFactory("TestERC20")
    const USDC = (await tokenFactory.deploy("TestUSDC", "USDC")) as TestERC20
    const vaultFactory = await ethers.getContractFactory("Vault")
    const vault = (await vaultFactory.deploy(USDC.address)) as Vault
    const insuranceFundFactory = await ethers.getContractFactory("InsuranceFund")
    const insuranceFund = (await insuranceFundFactory.deploy(vault.address)) as InsuranceFund

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

    // deploy clearingHouse
    const clearingHouseFactory = await ethers.getContractFactory("ClearingHouse")
    const clearingHouse = (await clearingHouseFactory.deploy(
        mockedVault.address,
        mockedInsuranceFund.address,
        mockedQuoteToken.address,
        mockedUniV3Factory.address,
        0,
    )) as ClearingHouse

    const exchangeFactory = await ethers.getContractFactory("Exchange")
    const exchange = (await exchangeFactory.deploy(
        clearingHouse.address,
        mockedUniV3Factory.address,
        token1.address,
        0,
    )) as Exchange
    const mockedExchange = await smockit(exchange)
    await clearingHouse.setExchange(mockedExchange.address)

    // deployer ensure base token is always smaller than quote in order to achieve base=token0 and quote=token1
    const mockedBaseToken = await mockedTokenTo(ADDR_LESS_THAN, mockedQuoteToken.address)

    return {
        clearingHouse,
        mockedExchange,
        mockedUniV3Factory,
        mockedVault,
        mockedQuoteToken,
        mockedUSDC,
        mockedBaseToken,
    }
}
