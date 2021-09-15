import { MockContract, ModifiableContract, smockit, smoddit } from "@eth-optimism/smock"
import { ethers } from "hardhat"
import { ClearingHouse, ClearingHouseConfig, InsuranceFund, UniswapV3Factory, Vault } from "../../typechain"

interface MockedVaultFixture {
    vault: Vault
    USDC: ModifiableContract
    mockedClearingHouse: MockContract
    mockedInsuranceFund: MockContract
}

interface VaultFixture {
    vault: Vault
    USDC: ModifiableContract
    clearingHouse: ClearingHouse
    insuranceFund: InsuranceFund
}

export async function mockedVaultFixture(): Promise<MockedVaultFixture> {
    // deploy test tokens
    const tokenModifiableFactory = await smoddit("TestERC20")
    const USDC = (await tokenModifiableFactory.deploy()) as ModifiableContract
    await USDC.initialize("TestUSDC", "USDC")

    const vaultFactory = await ethers.getContractFactory("Vault")
    const vault = (await vaultFactory.deploy()) as Vault
    await vault.initialize(USDC.address)

    const insuranceFundFactory = await ethers.getContractFactory("InsuranceFund")
    const insuranceFund = (await insuranceFundFactory.deploy()) as InsuranceFund
    const mockedInsuranceFund = await smockit(insuranceFund)

    // deploy clearingHouse
    const factoryFactory = await ethers.getContractFactory("UniswapV3Factory")
    const uniV3Factory = (await factoryFactory.deploy()) as UniswapV3Factory

    const clearingHouseConfigFactory = await ethers.getContractFactory("ClearingHouseConfig")
    const clearingHouseConfig = (await clearingHouseConfigFactory.deploy()) as ClearingHouseConfig
    await clearingHouseConfig.initialize()

    const clearingHouseFactory = await ethers.getContractFactory("ClearingHouse")
    const clearingHouse = (await clearingHouseFactory.deploy()) as ClearingHouse
    await clearingHouse.initialize(
        clearingHouseConfig.address,
        vault.address,
        insuranceFund.address,
        USDC.address,
        uniV3Factory.address,
    )
    const mockedClearingHouse = await smockit(clearingHouse)

    await vault.setInsuranceFund(mockedInsuranceFund.address)
    await vault.setClearingHouse(mockedClearingHouse.address)

    return { vault, USDC, mockedClearingHouse, mockedInsuranceFund }
}
