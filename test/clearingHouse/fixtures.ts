import { MockContract, smockit } from "@eth-optimism/smock"
import { ethers } from "hardhat"
import { ClearingHouse, TestERC20, TestUniswapV3Broker, UniswapV3Factory, UniswapV3Pool } from "../../typechain"
import { tokensFixture, uniswapV3FactoryFixture } from "../shared/fixtures"

interface ClearingHouseFixture {
    clearingHouse: ClearingHouse
    uniV3Factory: UniswapV3Factory
    pool: UniswapV3Pool
    feeTier: number
    USDC: TestERC20
    quoteToken: TestERC20
    baseToken: TestERC20
}

interface UniswapV3BrokerFixture {
    uniswapV3Broker: TestUniswapV3Broker
}

export function createClearingHouseFixture(isBase0quote1: boolean): () => Promise<ClearingHouseFixture> {
    return async (): Promise<ClearingHouseFixture> => {
        // deploy test tokens
        const tokenFactory = await ethers.getContractFactory("TestERC20")
        const USDC = (await tokenFactory.deploy("TestUSDC", "USDC")) as TestERC20

        let baseToken: TestERC20, quoteToken: TestERC20
        const { token0, token1 } = await tokensFixture()

        if (isBase0quote1) {
            baseToken = token0
            quoteToken = token1
        } else {
            baseToken = token1
            quoteToken = token0
        }

        // deploy UniV3 factory
        const factoryFactory = await ethers.getContractFactory("UniswapV3Factory")
        const uniV3Factory = (await factoryFactory.deploy()) as UniswapV3Factory

        // deploy clearingHouse
        const clearingHouseFactory = await ethers.getContractFactory("ClearingHouse")
        const clearingHouse = await clearingHouseFactory.deploy(USDC.address, quoteToken.address, uniV3Factory.address)

        // set CH as the minter of all virtual tokens
        await baseToken.setMinter(clearingHouse.address)
        await quoteToken.setMinter(clearingHouse.address)

        // deploy a pool
        const feeTier = 10000
        await uniV3Factory.createPool(baseToken.address, quoteToken.address, feeTier)
        const poolAddr = await uniV3Factory.getPool(baseToken.address, quoteToken.address, feeTier)

        const poolFactory = await ethers.getContractFactory("UniswapV3Pool")
        const pool = poolFactory.attach(poolAddr)

        return { clearingHouse, uniV3Factory, pool, feeTier, USDC, quoteToken, baseToken }
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
    mockedVUSD: MockContract
    mockedUSDC: MockContract
    mockedBaseToken: MockContract
}

export const LONGER_THAN = true
export const SHORTER_THAN = false
export async function mockedTokenTo(longerThan: boolean, targetAddr: string): Promise<MockContract> {
    // deployer ensure base token is always smaller than quote in order to achieve base=token0 and quote=token1
    let mockedToken: MockContract
    while (
        !mockedToken ||
        (longerThan
            ? mockedToken.address.toLowerCase() <= targetAddr.toLowerCase()
            : mockedToken.address.toLowerCase() >= targetAddr.toLowerCase())
    ) {
        const token = await deployERC20()
        mockedToken = await smockit(token)
    }
    return mockedToken
}

export async function mockedClearingHouseFixture(): Promise<MockedClearingHouseFixture> {
    // deploy test tokens
    const tokenFactory = await ethers.getContractFactory("TestERC20")
    const vUSD = (await tokenFactory.deploy("vUSD", "vUSD")) as TestERC20
    const USDC = (await tokenFactory.deploy("TestUSDC", "USDC")) as TestERC20
    const mockedVUSD = await smockit(vUSD)
    const mockedUSDC = await smockit(USDC)

    // deploy UniV3 factory
    const factoryFactory = await ethers.getContractFactory("UniswapV3Factory")
    const uniV3Factory = (await factoryFactory.deploy()) as UniswapV3Factory
    const mockedUniV3Factory = await smockit(uniV3Factory)

    // deploy clearingHouse
    const clearingHouseFactory = await ethers.getContractFactory("ClearingHouse")
    const clearingHouse = await clearingHouseFactory.deploy(
        mockedUSDC.address,
        mockedVUSD.address,
        mockedUniV3Factory.address,
    )

    // deployer ensure base token is always smaller than quote in order to achieve base=token0 and quote=token1
    const mockedBaseToken = await mockedTokenTo(SHORTER_THAN, mockedVUSD.address)

    return { clearingHouse, mockedUniV3Factory, mockedVUSD, mockedUSDC, mockedBaseToken }
}

export async function deployERC20(): Promise<TestERC20> {
    const tokenFactory = await ethers.getContractFactory("TestERC20")
    return (await tokenFactory.deploy("Test", "Test")) as TestERC20
}
