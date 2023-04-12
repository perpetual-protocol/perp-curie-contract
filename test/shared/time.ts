import { waffle } from "hardhat"
import { TestClearingHouse } from "../../typechain"

// There are two kinds of timestamps:
// 1. the real one by hardhat
// 2. mocked ones as written in TestClearingHouse, TestExchange and TestAccountBalance
// By mocking timestamps in ClearingHouse, Exchange and AccountBalance, we can get the accurate funding payments
// that won't be affected by txs sent by hardhat, as each tx increases timestamp by 1 second (the automine feature by hardhat)

// default increase amount by 10 as we cannot set a timestamp <= than the current one
// if there are txs before forwarding, the real timestamp can be ahead several seconds
export async function forwardBothTimestamps(clearingHouse: TestClearingHouse, forward: number = 10) {
    const next = (await getMockTimestamp(clearingHouse)) + forward
    const realTimestamp = await getRealTimestamp()
    if (next > realTimestamp) {
        await setBothTimestamps(clearingHouse, next)
    } else {
        await clearingHouse.setBlockTimestamp(next)
    }
}

async function getMockTimestamp(clearingHouse: TestClearingHouse) {
    return (await clearingHouse.getBlockTimestamp()).toNumber()
}

export async function initiateBothTimestamps(clearingHouse: TestClearingHouse) {
    // cannot set a timestamp <= than the current one, thus adding a random increment amount
    const initialTimestamp = (await getRealTimestamp()) + 100
    await setBothTimestamps(clearingHouse, initialTimestamp)
}

export async function setBothTimestamps(clearingHouse: TestClearingHouse, timestamp: number) {
    await clearingHouse.setBlockTimestamp(timestamp)
    await setRealTimestamp(timestamp)
}

export async function forwardRealTimestamp(forward: number) {
    const now = await getRealTimestamp()
    await waffle.provider.send("evm_mine", [now + forward])
}

export async function setRealTimestamp(timestamp: number) {
    await waffle.provider.send("evm_mine", [timestamp])
}

export async function getRealTimestamp() {
    return (await waffle.provider.getBlock("latest")).timestamp
}
