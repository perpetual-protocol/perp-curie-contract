import { ClearingHouse, TestERC20, TestUniswapV3Broker } from "../../typechain"
import { MockContract, smockit } from "@eth-optimism/smock"

import { UniswapV3Factory } from "../../typechain/uniswap"
import { ethers } from "hardhat"
import { uniswapV3FactoryFixture } from "./fixtures"

interface ClearingHouseFixture {
    clearingHouse: ClearingHouse
    mockUniV3Factory: MockContract
    mockVUSDC: MockContract
    mockUSDC: MockContract
}

interface TestUniswapV3BrokerFixture {
    testUniswapV3Broker: TestUniswapV3Broker
}

export async function clearingHouseFixture(): Promise<ClearingHouseFixture> {
    return deployClearingHouse()
}

export async function deployClearingHouse(): Promise<ClearingHouseFixture> {
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

    return { clearingHouse, mockUniV3Factory, mockVUSDC, mockUSDC }
}

export async function testUniswapV3BrokerFixture(): Promise<TestUniswapV3BrokerFixture> {
    const factory = await uniswapV3FactoryFixture()
    const testUniswapV3BrokerFactory = await ethers.getContractFactory("TestUniswapV3Broker")
    const testUniswapV3Broker = (await testUniswapV3BrokerFactory.deploy(factory.address)) as TestUniswapV3Broker
    return { testUniswapV3Broker }
}
