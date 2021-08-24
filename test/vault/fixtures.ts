import { ethers } from "hardhat"
import { MetaTxGateway, TestERC20, Vault } from "../../typechain"

interface VaultFixture {
    vault: Vault
    USDC: TestERC20
}

export function createVaultFixture(): () => Promise<VaultFixture> {
    return async (): Promise<VaultFixture> => {
        // deploy meta tx gateway
        const metaTxGatewayFactory = await ethers.getContractFactory("MetaTxGateway")
        const metaTxGateway = (await metaTxGatewayFactory.deploy("Lushan", "1", 1)) as MetaTxGateway

        // deploy test tokens
        const tokenFactory = await ethers.getContractFactory("TestERC20")
        const USDC = (await tokenFactory.deploy("TestUSDC", "USDC")) as TestERC20

        const vaultFactory = await ethers.getContractFactory("Vault")
        const vault = (await vaultFactory.deploy(USDC.address, metaTxGateway.address)) as Vault
        return { vault, USDC }
    }
}
