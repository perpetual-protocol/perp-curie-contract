// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { SafeOwnable } from "./base/SafeOwnable.sol";

contract VirtualToken is SafeOwnable, ERC20 {
    event WhitelistAdded(address account);
    event WhitelistRemoved(address account);

    address public minter;
    mapping(address => bool) internal _whitelistMap;

    constructor(string memory nameArg, string memory symbolArg) ERC20(nameArg, symbolArg) {
        // transfer to 0 = burn
        _whitelistMap[address(0)] = true;
    }

    /**
     * @dev Destroys `amount` tokens from the caller.
     *
     * See {ERC20-_burn}.
     */
    function burn(uint256 amount) external {
        _burn(_msgSender(), amount);
    }

    function mint(address to, uint256 amount) external {
        // only minter
        require(_msgSender() == minter, "VT_OM");
        _mint(to, amount);
    }

    function setMinter(address minterArg) external onlyOwner {
        minter = minterArg;
    }

    function addWhitelist(address account) external onlyOwner {
        _whitelistMap[account] = true;
        emit WhitelistAdded(account);
    }

    function removeWhitelist(address account) external onlyOwner {
        _whitelistMap[account] = false;
        emit WhitelistRemoved(account);
    }

    /// @inheritdoc ERC20
    function _beforeTokenTransfer(
        address from,
        address to,
        uint256 amount
    ) internal virtual override {
        super._beforeTokenTransfer(from, to, amount);

        // FIXME added it back once finishing mint/burn at exchange, or add exchange to whitelist
        // not whitelisted
        //        require(_whitelistMap[from], "VT_NW");
    }
}
