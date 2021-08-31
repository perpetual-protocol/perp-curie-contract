import { waffle } from "hardhat"
import { MockContract } from "@eth-optimism/smock"
import { TestClearingHouse } from "../../typechain"

export async function forward(seconds: number) {
    const lastTimestamp = (await waffle.provider.getBlock("latest")).timestamp
    await waffle.provider.send("evm_setNextBlockTimestamp", [lastTimestamp + seconds])
    await waffle.provider.send("evm_mine", [])
}

export async function forwardBlock(mockedArbSys: MockContract, blockSteps: number = 1) {
    const currentBlock = await mockedArbSys.arbBlockNumber()
    mockedArbSys.smocked.arbBlockNumber.will.return.with(async () => {
        return currentBlock + blockSteps
    })
}

export async function forwardTimestamp(clearingHouse: TestClearingHouse, step: number = 1) {
    const now = await clearingHouse.getBlockTimestamp()
    await clearingHouse.setBlockTimestamp(now.add(step))
}
