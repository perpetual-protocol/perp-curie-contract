import { Wallet } from "ethers"
import { parseUnits } from "ethers/lib/utils"
import { TestERC20, Vault } from "../../typechain"
import { ClearingHouseFixture } from "../clearingHouse/fixtures"

export async function deposit(sender: Wallet, vault: Vault, amount: number, token: TestERC20): Promise<void> {
    const decimals = await token.decimals()
    const parsedAmount = parseUnits(amount.toString(), decimals)
    await token.connect(sender).approve(vault.address, parsedAmount)
    await vault.connect(sender).deposit(token.address, parsedAmount)
}

export async function mintAndDeposit(fixture: ClearingHouseFixture, wallet: Wallet, amount: number): Promise<void> {
    const usdc = fixture.USDC
    const decimals = await usdc.decimals()
    await usdc.mint(wallet.address, parseUnits(amount.toString(), decimals))
    await deposit(wallet, fixture.vault, amount, usdc)
}
