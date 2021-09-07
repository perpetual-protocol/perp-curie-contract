// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { SafeOwnable } from "./base/SafeOwnable.sol";

contract VirtualToken is SafeOwnable, ERC20 {
    mapping(address => bool) internal _whitelistMap;

    event WhitelistAdded(address account);
    event WhitelistRemoved(address account);

    constructor(string memory nameArg, string memory symbolArg) public ERC20(nameArg, symbolArg) {
        // transfer to 0 = burn
        _whitelistMap[address(0)] = true;
    }

    function mintMaximumTo(address recipient) external onlyOwner {
        _mint(recipient, type(uint256).max);
    }

    function addWhitelist(address account) external onlyOwner {
        _whitelistMap[account] = true;
        emit WhitelistAdded(account);
    }

    function removeWhitelist(address account) external onlyOwner {
        _whitelistMap[account] = false;
        emit WhitelistRemoved(account);
    }

    function isWhitelist(address account) external view returns (bool) {
        return _whitelistMap[account];
    }

    /// @inheritdoc ERC20
    function _beforeTokenTransfer(
        address from,
        address to,
        uint256 amount
    ) internal virtual override {
        super._beforeTokenTransfer(from, to, amount);

        // not whitelisted
        require(_whitelistMap[from], "VT_NW");
    }
}
