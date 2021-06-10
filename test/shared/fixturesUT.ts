import { MockContract, smockit } from "@eth-optimism/smock"
import { ethers } from "hardhat"
import { ClearingHouse, TestERC20, TestUniswapV3Broker, UniswapV3Factory } from "../../typechain"
import { uniswapV3FactoryFixture } from "./fixtures"

interface ClearingHouseFixture {
    clearingHouse: ClearingHouse
    mockUniV3Factory: MockContract
    mockVUSDC: MockContract
    mockUSDC: MockContract
    mockBaseToken: MockContract
}

interface UniswapV3BrokerFixture {
    uniswapV3Broker: TestUniswapV3Broker
}

export async function clearingHouseFixture(): Promise<ClearingHouseFixture> {
    // deploy test tokens
    const tokenFactory = await ethers.getContractFactory("TestERC20")
    const vUSDC = (await tokenFactory.deploy("vTestUSDC", "vUSDC")) as TestERC20
    const USDC = (await tokenFactory.deploy("TestUSDC", "USDC")) as TestERC20
    const mockVUSDC = await smockit(vUSDC)
    const mockUSDC = await smockit(USDC)

    // deploy UniV3 factory
    const factoryFactory = await ethers.getContractFactory("UniswapV3Factory")
    const factory = (await factoryFactory.deploy()) as UniswapV3Factory
    const mockUniV3Factory = await smockit(factory)

    // deploy clearingHouse
    const clearingHouseFactory = await ethers.getContractFactory("ClearingHouse")
    const clearingHouse = await clearingHouseFactory.deploy(
        mockVUSDC.address,
        mockUSDC.address,
        mockUniV3Factory.address,
    )
    const baseToken = await deployERC20()
    const mockBaseToken = await smockit(baseToken)

    return { clearingHouse, mockUniV3Factory, mockVUSDC, mockUSDC, mockBaseToken }
}

export async function uniswapV3BrokerFixture(): Promise<UniswapV3BrokerFixture> {
    const factory = await uniswapV3FactoryFixture()
    const uniswapV3BrokerFactory = await ethers.getContractFactory("TestUniswapV3Broker")
    const uniswapV3Broker = (await uniswapV3BrokerFactory.deploy(factory.address)) as TestUniswapV3Broker
    return { uniswapV3Broker }
}

export async function deployERC20(): Promise<TestERC20> {
    const tokenFactory = await ethers.getContractFactory("TestERC20")
    return (await tokenFactory.deploy("Test", "Test")) as TestERC20
}
