pragma solidity 0.7.6;

import { ArbBlockContext } from "./ArbBlockContext.sol";

abstract contract DeadlineChecker is ArbBlockContext {
    modifier checkDeadline(uint256 deadline) {
        // transaction too old
        require(_blockTimestamp() <= deadline, "DC_TTO");
        _;
    }
}
