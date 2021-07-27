import { Wallet } from "ethers"
import { TestERC20, Vault } from "../../typechain"
import { toWei } from "./number"

export async function deposit(sender: Wallet, vault: Vault, amount: number, token: TestERC20): Promise<void> {
    const decimals = await token.decimals()
    const amountToWei = toWei(amount, decimals)
    await token.connect(sender).approve(vault.address, amountToWei)
    await vault.connect(sender).deposit(sender.address, token.address, amountToWei)
}
