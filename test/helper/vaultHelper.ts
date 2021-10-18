import { ContractTransaction, Wallet } from "ethers"
import { formatUnits } from "ethers/lib/utils"
import { ClearingHouseFixture } from "../clearingHouse/fixtures"

export async function withdrawAll(fixture: ClearingHouseFixture, wallet: Wallet): Promise<ContractTransaction> {
    const vault = fixture.vault
    const freeCollateral = await vault.getFreeCollateral(wallet.address)
    const token = await vault.getSettlementToken()
    console.log(`freeCollateral=${formatUnits(freeCollateral, 6)}`)
    return vault.connect(wallet).withdraw(token, freeCollateral)
}
