import { smockit } from "@eth-optimism/smock"
import { ethers } from "hardhat"
import { AccountBalance, ClearingHouseConfig, TestERC20, Vault } from "../../typechain"

interface VaultFixture {
    vault: Vault
    USDC: TestERC20
}

export function createVaultFixture(): () => Promise<VaultFixture> {
    return async (): Promise<VaultFixture> => {
        // deploy test tokens
        const tokenFactory = await ethers.getContractFactory("TestERC20")
        const USDC = (await tokenFactory.deploy()) as TestERC20
        await USDC.initialize("TestUSDC", "USDC")

        const clearingHouseConfigFactory = await ethers.getContractFactory("ClearingHouseConfig")
        const clearingHouseConfig = (await clearingHouseConfigFactory.deploy()) as ClearingHouseConfig
        const mockedConfig = await smockit(clearingHouseConfig)

        const accountBalanceFactory = await ethers.getContractFactory("AccountBalance")
        const accountBalance = (await accountBalanceFactory.deploy()) as AccountBalance
        const mockedAccountBalance = await smockit(accountBalance)

        const vaultFactory = await ethers.getContractFactory("Vault")
        const vault = (await vaultFactory.deploy()) as Vault
        await vault.initialize(USDC.address, mockedConfig.address, mockedAccountBalance.address)
        return { vault, USDC }
    }
}
