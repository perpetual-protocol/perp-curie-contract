import { MockContract, smockit } from "@eth-optimism/smock"
import { parseEther } from "ethers/lib/utils"
import { ethers } from "hardhat"
import {
    AccountBalance,
    ClearingHouse,
    ClearingHouseConfig,
    CollateralManager,
    Exchange,
    InsuranceFund,
    MarketRegistry,
    OrderBook,
    TestERC20,
    UniswapV3Factory,
    Vault,
} from "../../typechain"
import { createQuoteTokenFixture } from "../shared/fixtures"

interface MockedVaultFixture {
    vault: Vault
    USDC: TestERC20
    mockedInsuranceFund: MockContract
    mockedAccountBalance: MockContract
    mockedClearingHouseConfig: MockContract
    mockedCollateralManager: MockContract
}

export async function mockedVaultFixture(): Promise<MockedVaultFixture> {
    // deploy test tokens
    const tokenFactory = await ethers.getContractFactory("TestERC20")
    const USDC = (await tokenFactory.deploy()) as TestERC20
    await USDC.__TestERC20_init("TestUSDC", "USDC", 6)

    const insuranceFundFactory = await ethers.getContractFactory("InsuranceFund")
    const insuranceFund = (await insuranceFundFactory.deploy()) as InsuranceFund
    const mockedInsuranceFund = await smockit(insuranceFund)
    mockedInsuranceFund.smocked.getToken.will.return.with(USDC.address)

    // deploy clearingHouse
    const factoryFactory = await ethers.getContractFactory("UniswapV3Factory")
    const uniV3Factory = (await factoryFactory.deploy()) as UniswapV3Factory

    const marketRegistryFactory = await ethers.getContractFactory("MarketRegistry")
    const marketRegistry = (await marketRegistryFactory.deploy()) as MarketRegistry
    await marketRegistry.initialize(uniV3Factory.address, USDC.address)

    const orderBookFactory = await ethers.getContractFactory("OrderBook")
    const orderBook = (await orderBookFactory.deploy()) as OrderBook
    await orderBook.initialize(marketRegistry.address)

    const clearingHouseConfigFactory = await ethers.getContractFactory("ClearingHouseConfig")
    const clearingHouseConfig = (await clearingHouseConfigFactory.deploy()) as ClearingHouseConfig
    const mockedClearingHouseConfig = await smockit(clearingHouseConfig)

    const exchangeFactory = await ethers.getContractFactory("Exchange")
    const exchange = (await exchangeFactory.deploy()) as Exchange
    await exchange.initialize(marketRegistry.address, orderBook.address, clearingHouseConfig.address)
    const mockedExchange = await smockit(exchange)
    await orderBook.setExchange(exchange.address)

    const accountBalanceFactory = await ethers.getContractFactory("AccountBalance")
    const accountBalance = (await accountBalanceFactory.deploy()) as AccountBalance
    const mockedAccountBalance = await smockit(accountBalance)

    const vaultFactory = await ethers.getContractFactory("Vault")
    const vault = (await vaultFactory.deploy()) as Vault
    await vault.initialize(
        mockedInsuranceFund.address,
        mockedClearingHouseConfig.address,
        mockedAccountBalance.address,
        mockedExchange.address,
    )

    const collateralManagerFactory = await ethers.getContractFactory("CollateralManager")
    const collateralManager = (await collateralManagerFactory.deploy()) as CollateralManager
    await collateralManager.initialize(
        clearingHouseConfig.address,
        vault.address,
        5,
        "800000",
        "500000",
        "2000",
        "30000",
        parseEther("10000"),
        parseEther("500"),
    )
    const mockedCollateralManager = await smockit(collateralManager)

    const quoteToken = await createQuoteTokenFixture("RandomTestToken1", "randomToken1")()
    mockedExchange.smocked.getOrderBook.will.return.with(orderBook.address)
    const clearingHouseFactory = await ethers.getContractFactory("ClearingHouse")
    const clearingHouse = (await clearingHouseFactory.deploy()) as ClearingHouse
    await clearingHouse.initialize(
        clearingHouseConfig.address,
        vault.address,
        quoteToken.address,
        uniV3Factory.address,
        mockedExchange.address,
        mockedAccountBalance.address,
        insuranceFund.address,
    )
    const mockedClearingHouse = await smockit(clearingHouse)

    await vault.setClearingHouse(mockedClearingHouse.address)
    await vault.setCollateralManager(mockedCollateralManager.address)

    return {
        vault,
        USDC,
        mockedInsuranceFund,
        mockedAccountBalance,
        mockedClearingHouseConfig,
        mockedCollateralManager,
    }
}
