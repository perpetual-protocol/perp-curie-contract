pragma solidity 0.7.6;

import { ArbSys } from "../interface/Arbitrum/ArbSys.sol";

abstract contract ArbBlockContext {
    function _blockTimestamp() internal view virtual returns (uint256) {
        // Reply from Arbitrum
        // block.timestamp returns timestamp at the time at which the sequencer receives the tx.
        // It may not actually correspond to a particular L1 block
        return block.timestamp;
    }

    function _blockNumber() internal view virtual returns (uint256) {
        // according Arbitrum doc, the address of ArbSys will be 0x0000000000000000000000000000000000000064
        // which is 100
        return ArbSys(address(100)).arbBlockNumber();
    }
}
