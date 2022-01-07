import { waffle } from "hardhat"
import { TestClearingHouse } from "../../typechain"

export async function forward(seconds: number) {
    const lastTimestamp = (await waffle.provider.getBlock("latest")).timestamp
    await waffle.provider.send("evm_setNextBlockTimestamp", [lastTimestamp + seconds])
    await waffle.provider.send("evm_mine", [])
}

export async function forwardTimestamp(clearingHouse: TestClearingHouse, step: number = 1) {
    const now = await clearingHouse.getBlockTimestamp()
    await clearingHouse.setBlockTimestamp(now.add(step))
}

export async function setNextBlockTimestamp(timestamp: number) {
    await waffle.provider.send("evm_setNextBlockTimestamp", [timestamp])
    await waffle.provider.send("evm_mine", [])
}
