import { TransactionReceipt } from "@ethersproject/abstract-provider"
import { Contract } from "ethers"
import { LogDescription } from "ethers/lib/utils"

export function findEvent(
    receipt: TransactionReceipt,
    contract: Contract,
    eventName: string,
    index = 0,
): LogDescription {
    const eventTopic = contract.interface.getEventTopic(eventName)
    return receipt.logs.filter(log => log.topics[0] === eventTopic).map(log => contract.interface.parseLog(log))[index]
}
