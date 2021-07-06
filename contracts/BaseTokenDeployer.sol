pragma solidity 0.7.6;

import { ERC20PresetMinterPauser } from "@openzeppelin/contracts/presets/ERC20PresetMinterPauser.sol";
import { Create2 } from "@openzeppelin/contracts/utils/create2.sol";
import { BaseToken } from "./BaseToken.sol";

contract BaseTokenDeployer {
    function deploy(bytes32 salt, bytes memory bytecode) external returns (address) {
        address baseToken = Create2.deploy(0, salt, bytecode);

        // msg.sender would be our testnet deployer
        BaseToken(baseToken).grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        BaseToken(baseToken).grantRole(MINTER_ROLE, msg.sender);
        BaseToken(baseToken).grantRole(PAUSER_ROLE, msg.sender);
    }
}
