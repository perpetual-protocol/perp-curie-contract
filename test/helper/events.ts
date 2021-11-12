import { LogDescription } from "@ethersproject/abi"
import { TransactionReceipt } from "@ethersproject/abstract-provider"
import { BaseContract } from "ethers"

export function retrieveEvent(
    txReceipt: TransactionReceipt,
    contract: BaseContract,
    eventName: string,
): LogDescription {
    const eventTopic = contract.interface.getEventTopic(eventName)
    const parsedLogs = txReceipt.logs
        .filter(log => log.topics[0] === eventTopic)
        .map(log => contract.interface.parseLog(log))
    return parsedLogs[0]
}
