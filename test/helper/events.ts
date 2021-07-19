import { ContractTransaction, Event } from "ethers"

export async function findEvent(eventLogs: Event[], name: string): Promise<Event> {
    for (const eventLog of eventLogs) {
        if (eventLog.event === name) {
            return eventLog
        }
    }
}

export async function runTxAndReturnEvent(txFunction: Promise<ContractTransaction>, name: string): Promise<Event> {
    const tx = await txFunction
    const receipt = await tx.wait()
    return await findEvent(receipt.events, name)
}
