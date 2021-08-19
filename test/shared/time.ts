import { waffle } from "hardhat"
import { MockContract } from "@eth-optimism/smock"

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
