pragma solidity 0.7.6;

import { ArbBlockContext } from "../arbitrum/ArbBlockContext.sol";

abstract contract Validation is ArbBlockContext {
    modifier checkDeadline(uint256 deadline) {
        // transaction too old
        require(_blockTimestamp() <= deadline, "V_TTO");
        _;
    }
}
