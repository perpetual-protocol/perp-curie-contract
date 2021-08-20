// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;
import "../arbitrum/ArbSys.sol";

contract TestArbSys is ArbSys {
    constructor() {}

    /**
     * @notice Get internal version number identifying an ArbOS build
     * @return version number as int
     */
    function arbOSVersion() external pure override returns (uint256) {
        revert();
    }

    /**
     * @notice Get Arbitrum block number (distinct from L1 block number; Arbitrum genesis block has block number 0)
     * @return block number as int
     */
    function arbBlockNumber() external view override returns (uint256) {
        revert();
    }

    /**
     * @notice Send given amount of Eth to dest from sender.
     * This is a convenience function, which is equivalent to calling sendTxToL1 with empty calldataForL1.
     * @param destination recipient address on L1
     * @return unique identifier for this L2-to-L1 transaction.
     */
    function withdrawEth(address destination) external payable override returns (uint256) {
        revert();
    }

    /**
     * @notice Send a transaction to L1
     * @param destination recipient address on L1
     * @param calldataForL1 (optional) calldata for L1 contract call
     * @return a unique identifier for this L2-to-L1 transaction.
     */
    function sendTxToL1(address destination, bytes calldata calldataForL1) external payable override returns (uint256) {
        revert();
    }

    /**
     * @notice get the number of transactions issued by the given external account or the account sequence number
     *         of the given contract
     * @param account target account
     * @return the number of transactions issued by the given external account or the account sequence number
     *         of the given contract
     */
    function getTransactionCount(address account) external view override returns (uint256) {
        revert();
    }

    /**
     * @notice get the value of target L2 storage slot
     * This function is only callable from address 0 to prevent contracts from being able to call it
     * @param account target account
     * @param index target index of storage slot
     * @return stotage value for the given account at the given index
     */
    function getStorageAt(address account, uint256 index) external view override returns (uint256) {
        revert();
    }

    /**
     * @notice check if current call is coming from l1
     * @return true if the caller of this was called directly from L1
     */
    function isTopLevelCall() external view override returns (bool) {
        revert();
    }
}
