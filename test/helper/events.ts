import { LogDescription } from "@ethersproject/abi"
import { TransactionReceipt } from "@ethersproject/abstract-provider"
import { BaseContract } from "ethers"

// NOTE: Chai/Waffle doesn't handle "one contract emits multiple events" correctly, for instance,
// await expect(clearingHouse.openPosition())
//     .to.emit(exchange, "FundingPaymentSettled").withArgs(xxx) -> THIS CHECK WILL BE IGNORED
//     .to.emit(exchange, "FundingUpdated").withArgs(xxx)
// We need to use retrieveEvent() to retrieve each event separately.
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
