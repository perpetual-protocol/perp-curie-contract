import { MockContract, smockit } from "@eth-optimism/smock"
import { ethers } from "hardhat"
import { InsuranceFund, TestERC20, Vault } from "../../typechain"

interface MockedInsuranceFundFixture {
    insuranceFund: InsuranceFund
    USDC: TestERC20
    mockedVault: MockContract
}

export async function mockedInsuranceFundFixture(): Promise<MockedInsuranceFundFixture> {
    // deploy test tokens
    const tokenFactory = await ethers.getContractFactory("TestERC20")
    const USDC = (await tokenFactory.deploy()) as TestERC20
    await USDC.__TestERC20_init("TestUSDC", "USDC", 6)

    const insuranceFundFactory = await ethers.getContractFactory("InsuranceFund")
    const insuranceFund = (await insuranceFundFactory.deploy()) as InsuranceFund
    await insuranceFund.initialize(USDC.address)

    const vaultFactory = await ethers.getContractFactory("Vault")
    const vault = (await vaultFactory.deploy()) as Vault
    const mockedVault = await smockit(vault)

    return { insuranceFund, USDC, mockedVault }
}
